// backend/src/collectors/multi_source_token_scanner.js
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class MultiSourceTokenScanner extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL
        );
        
        this.isScanning = false;
        this.scanInterval = 10000; // 10 seconds for multi-source
        this.processedTokens = new Set();
        
        // Scanner instances will be initialized in setupScanners
        this.scanners = {};
        
        // Priority configuration
        this.sourcePriority = {
            'pumpfun': 10,
            'moonshot': 9,
            'raydium': 8,
            'orca': 7,
            'dexscreener': 6,
            'birdeye': 5
        };
        
        // Rate limiting per source
        this.rateLimits = {
            'pumpfun': { max: 30, window: 60000, current: 0, reset: Date.now() + 60000 },
            'moonshot': { max: 60, window: 60000, current: 0, reset: Date.now() + 60000 },
            'dexscreener': { max: 120, window: 60000, current: 0, reset: Date.now() + 60000 },
            'birdeye': { max: 100, window: 60000, current: 0, reset: Date.now() + 60000 }
        };
        
        this.setupScanners();
    }

    setupScanners() {
        // Initialize scanner configurations
        this.scannerConfigs = {
            pumpfun: {
                enabled: true,
                url: 'https://api.pump.fun/tokens',
                wsUrl: 'wss://api.pump.fun/v1/stream',
                scanInterval: 5000
            },
            moonshot: {
                enabled: true,
                url: 'https://api.moonshot.cc/tokens/v1/solana/new',
                scanInterval: 10000
            },
            dexscreener: {
                enabled: true,
                url: 'https://api.dexscreener.com/latest/dex/search',
                scanInterval: 15000
            },
            birdeye: {
                enabled: !!process.env.BIRDEYE_API_KEY,
                url: 'https://public-api.birdeye.so/defi/tokenlist',
                scanInterval: 20000
            }
        };
    }

    async startScanning() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        logger.info('🚀 Multi-Source Token Scanner started');

        // Start individual source scanners
        this.startSourceScanners();

        // Main aggregation loop
        this.scanTimer = setInterval(async () => {
            try {
                await this.aggregateAndProcessTokens();
            } catch (error) {
                logger.error('Multi-source scanner error:', error);
            }
        }, this.scanInterval);
    }

    startSourceScanners() {
        // Pump.fun scanner
        if (this.scannerConfigs.pumpfun?.enabled && this.startPumpFunScanner) {
            this.startPumpFunScanner();
        }

        // Moonshot scanner
        if (this.scannerConfigs.moonshot?.enabled && this.startMoonshotScanner) {
            this.startMoonshotScanner();
        }

        // DexScreener scanner
        if (this.scannerConfigs.dexscreener?.enabled && this.startDexScreenerScanner) {
            this.startDexScreenerScanner();
        }

        // Birdeye scanner
        if (this.scannerConfigs.birdeye?.enabled && this.startBirdeyeScanner) {
            this.startBirdeyeScanner();
        }
    }

    async checkRateLimit(source) {
        const limit = this.rateLimits[source];
        if (!limit) return true;

        // Reset if window passed
        if (Date.now() > limit.reset) {
            limit.current = 0;
            limit.reset = Date.now() + limit.window;
        }

        // Check if under limit
        if (limit.current >= limit.max) {
            logger.warn(`Rate limit reached for ${source}: ${limit.current}/${limit.max}`);
            return false;
        }

        limit.current++;
        return true;
    }

    // Pump.fun Scanner
    async startPumpFunScanner() {
        const scanner = {
            name: 'pumpfun',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.pumpfun = scanner;

        // Polling
        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('pumpfun')) return;

            try {
                const response = await axios.get(this.scannerConfigs.pumpfun.url, {
                    timeout: 5000,
                    params: { 
                        limit: 50,
                        sort: 'created',
                        order: 'desc'
                    }
                });

                const tokens = response.data?.tokens || [];
                
                for (const token of tokens) {
                    const processed = this.processPumpFunToken(token);
                    if (processed && !this.processedTokens.has(processed.address)) {
                        scanner.tokens.set(processed.address, processed);
                        this.emit('token', processed);
                    }
                }

                scanner.lastFetch = Date.now();
                logger.debug(`Pump.fun: Found ${tokens.length} tokens`);

            } catch (error) {
                logger.error('Pump.fun scanner error:', error.message);
            }
        };

        // Initial scan
        await scan();
        
        // Schedule periodic scans
        scanner.interval = setInterval(scan, this.scannerConfigs.pumpfun.scanInterval);

        // WebSocket for real-time updates
        this.connectPumpFunWebSocket();
    }

    connectPumpFunWebSocket() {
        try {
            const WebSocket = require('ws');
            const ws = new WebSocket(this.scannerConfigs.pumpfun.wsUrl);

            ws.on('open', () => {
                logger.info('Connected to Pump.fun WebSocket');
                ws.send(JSON.stringify({ 
                    type: 'subscribe', 
                    channel: 'new_tokens' 
                }));
            });

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'new_token') {
                        const processed = this.processPumpFunToken(message.token);
                        if (processed && !this.processedTokens.has(processed.address)) {
                            this.scanners.pumpfun.tokens.set(processed.address, processed);
                            this.emit('token', processed);
                            logger.info(`🔥 Real-time Pump.fun token: ${processed.symbol}`);
                        }
                    }
                } catch (error) {
                    logger.error('Pump.fun WS message error:', error);
                }
            });

            ws.on('error', (error) => {
                logger.error('Pump.fun WebSocket error:', error);
            });

            ws.on('close', () => {
                logger.info('Pump.fun WebSocket closed, reconnecting...');
                setTimeout(() => this.connectPumpFunWebSocket(), 5000);
            });

        } catch (error) {
            logger.error('Failed to connect Pump.fun WebSocket:', error);
        }
    }

    processPumpFunToken(token) {
        if (!token || !token.mint) return null;

        return {
            address: token.mint,
            symbol: token.symbol || 'UNKNOWN',
            name: token.name || 'Unknown Token',
            price: parseFloat(token.price || 0),
            liquidity: parseFloat(token.liquidity || 0),
            volume24h: parseFloat(token.volume_24h || 0),
            priceChange24h: parseFloat(token.price_change_24h || 0),
            marketCap: parseFloat(token.market_cap || 0),
            holders: parseInt(token.holders || 0),
            createdAt: token.created_at ? new Date(token.created_at).getTime() : Date.now(),
            source: 'pumpfun',
            priority: this.sourcePriority.pumpfun,
            metadata: {
                twitter: token.twitter,
                telegram: token.telegram,
                website: token.website
            }
        };
    }

    // Moonshot Scanner
    async startMoonshotScanner() {
        const scanner = {
            name: 'moonshot',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.moonshot = scanner;

        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('moonshot')) return;

            try {
                const response = await axios.get(this.scannerConfigs.moonshot.url, {
                    timeout: 5000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'MemecoinBot/1.0'
                    }
                });

                const tokens = response.data?.tokens || [];
                
                for (const token of tokens) {
                    const processed = this.processMoonshotToken(token);
                    if (processed && !this.processedTokens.has(processed.address)) {
                        scanner.tokens.set(processed.address, processed);
                        this.emit('token', processed);
                    }
                }

                scanner.lastFetch = Date.now();
                logger.debug(`Moonshot: Found ${tokens.length} tokens`);

            } catch (error) {
                logger.error('Moonshot scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.moonshot.scanInterval);
    }

    processMoonshotToken(token) {
        if (!token || !token.address) return null;

        return {
            address: token.address,
            symbol: token.symbol || 'UNKNOWN',
            name: token.name || 'Unknown Token',
            price: parseFloat(token.price || 0),
            liquidity: parseFloat(token.liquidity || 0),
            volume24h: parseFloat(token.volume || 0),
            priceChange24h: parseFloat(token.change_24h || 0),
            marketCap: parseFloat(token.market_cap || 0),
            holders: parseInt(token.holder_count || 0),
            createdAt: token.launch_date ? new Date(token.launch_date).getTime() : Date.now(),
            source: 'moonshot',
            priority: this.sourcePriority.moonshot,
            metadata: {
                progress: token.progress,
                stage: token.stage
            }
        };
    }

    // DexScreener Scanner (existing but enhanced)
    async startDexScreenerScanner() {
        const scanner = {
            name: 'dexscreener',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.dexscreener = scanner;

        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('dexscreener')) return;

            try {
                const response = await axios.get(this.scannerConfigs.dexscreener.url, {
                    params: { q: 'SOL' },
                    timeout: 10000
                });

                if (response.data?.pairs) {
                    const tokens = response.data.pairs
                        .filter(pair => {
                            if (!pair || !pair.baseToken) return false;
                            const age = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity;
                            return pair.chainId === 'solana' && age < 24 * 60 * 60 * 1000;
                        })
                        .map(pair => this.processDexScreenerToken(pair))
                        .filter(token => token && !this.processedTokens.has(token.address));

                    for (const token of tokens) {
                        scanner.tokens.set(token.address, token);
                        this.emit('token', token);
                    }

                    scanner.lastFetch = Date.now();
                    logger.debug(`DexScreener: Found ${tokens.length} new tokens`);
                }

            } catch (error) {
                logger.error('DexScreener scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.dexscreener.scanInterval);
    }

    processDexScreenerToken(pair) {
        if (!pair || !pair.baseToken) return null;

        return {
            address: pair.baseToken.address,
            symbol: pair.baseToken.symbol || 'UNKNOWN',
            name: pair.baseToken.name || 'Unknown Token',
            price: parseFloat(pair.priceUsd || 0),
            liquidity: parseFloat(pair.liquidity?.usd || 0),
            volume24h: parseFloat(pair.volume?.h24 || 0),
            priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
            marketCap: parseFloat(pair.fdv || 0),
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            createdAt: pair.pairCreatedAt || Date.now(),
            source: 'dexscreener',
            priority: this.sourcePriority.dexscreener
        };
    }

    // Birdeye Scanner
    async startBirdeyeScanner() {
        const scanner = {
            name: 'birdeye',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.birdeye = scanner;

        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('birdeye')) return;

            try {
                const response = await axios.get(this.scannerConfigs.birdeye.url, {
                    headers: { 
                        'X-API-KEY': process.env.BIRDEYE_API_KEY,
                        'x-chain': 'solana'
                    },
                    params: {
                        sort_by: 'v24hUSD',
                        sort_type: 'desc',
                        limit: 50
                    },
                    timeout: 10000
                });

                const tokens = response.data?.data?.tokens || [];
                
                for (const token of tokens) {
                    const processed = this.processBirdeyeToken(token);
                    if (processed && !this.processedTokens.has(processed.address)) {
                        scanner.tokens.set(processed.address, processed);
                        this.emit('token', processed);
                    }
                }

                scanner.lastFetch = Date.now();
                logger.debug(`Birdeye: Found ${tokens.length} tokens`);

            } catch (error) {
                logger.error('Birdeye scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.birdeye.scanInterval || 20000);
    }

    processBirdeyeToken(token) {
        if (!token || !token.address) return null;

        const age = token.createTime ? Date.now() - (token.createTime * 1000) : Infinity;
        if (age > 24 * 60 * 60 * 1000) return null; // Skip tokens older than 24 hours

        return {
            address: token.address,
            symbol: token.symbol || 'UNKNOWN',
            name: token.name || 'Unknown Token',
            price: parseFloat(token.price || 0),
            liquidity: parseFloat(token.liquidity || 0),
            volume24h: parseFloat(token.v24hUSD || 0),
            priceChange24h: parseFloat(token.v24hChangePercent || 0),
            marketCap: parseFloat(token.mc || 0),
            holders: parseInt(token.holder || 0),
            createdAt: token.createTime ? token.createTime * 1000 : Date.now(),
            source: 'birdeye',
            priority: this.sourcePriority.birdeye || 5
        };
    }

    // Aggregate and process tokens from all sources
    async aggregateAndProcessTokens() {
        const allTokens = [];

        // Collect tokens from all scanners
        for (const [source, scanner] of Object.entries(this.scanners)) {
            if (scanner.tokens) {
                for (const [address, token] of scanner.tokens) {
                    if (!this.processedTokens.has(address)) {
                        allTokens.push(token);
                    }
                }
            }
        }

        // Sort by priority and age
        allTokens.sort((a, b) => {
            // First by priority
            if (a.priority !== b.priority) {
                return b.priority - a.priority;
            }
            // Then by age (newer first)
            return b.createdAt - a.createdAt;
        });

        // Process top tokens
        const topTokens = allTokens.slice(0, 20);
        
        for (const token of topTokens) {
            await this.analyzeAndStoreToken(token);
            this.processedTokens.add(token.address);
        }

        // Clean up old processed tokens
        if (this.processedTokens.size > 1000) {
            const toRemove = Array.from(this.processedTokens).slice(0, 500);
            toRemove.forEach(addr => this.processedTokens.delete(addr));
        }
    }

    async analyzeAndStoreToken(token) {
        try {
            // Add source bonus to scoring
            const sourceBonus = {
                'pumpfun': 20,
                'moonshot': 15,
                'raydium': 10,
                'dexscreener': 5,
                'birdeye': 5
            };

            const bonus = sourceBonus[token.source] || 0;

            const analysis = {
                liquidityScore: this.scoreLiquidity(token.liquidity),
                momentumScore: this.scoreMomentum(token.priceChange24h || 0, token.volume24h),
                ageScore: this.scoreAge(token.createdAt) + bonus,
                volumeScore: this.scoreVolume(token.volume24h, token.liquidity),
                sourceScore: bonus
            };

            const overallScore = (
                analysis.liquidityScore * 0.2 +
                analysis.momentumScore * 0.2 +
                analysis.ageScore * 0.3 +
                analysis.volumeScore * 0.2 +
                analysis.sourceScore * 0.1
            );

            const riskScore = this.calculateRiskScore(token, analysis);

            // Lower threshold for priority sources
            const scoreThreshold = ['pumpfun', 'moonshot'].includes(token.source) ? 25 : 30;
            
            if (overallScore > scoreThreshold && riskScore < 85) {
                await this.db.addToken({
                    address: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    marketCap: token.marketCap,
                    liquidity: token.liquidity,
                    holders: token.holders || 0,
                    socialScore: token.source === 'pumpfun' ? 15 : 0,
                    riskScore: riskScore
                });

                logger.info(`✅ Added ${token.source} token: ${token.symbol} (Score: ${overallScore.toFixed(1)}, Risk: ${riskScore.toFixed(1)})`);
                
                // Emit high-priority alert for very new tokens
                if (Date.now() - token.createdAt < 5 * 60 * 1000) {
                    this.emit('high-priority', token);
                }
            }

        } catch (error) {
            logger.error(`Error analyzing token ${token.symbol}:`, error);
        }
    }

    // Scoring methods
    scoreLiquidity(liquidity) {
        if (liquidity >= 50000) return 100;
        if (liquidity >= 25000) return 80;
        if (liquidity >= 10000) return 60;
        if (liquidity >= 5000) return 40;
        if (liquidity >= 1000) return 20;
        return 10;
    }

    scoreMomentum(priceChange, volume24h) {
        let score = 50;
        
        if (priceChange > 100) score += 30;
        else if (priceChange > 50) score += 25;
        else if (priceChange > 20) score += 20;
        else if (priceChange > 10) score += 15;
        else if (priceChange > 5) score += 10;
        
        if (volume24h > 100000) score += 20;
        else if (volume24h > 50000) score += 15;
        else if (volume24h > 10000) score += 10;
        else if (volume24h > 1000) score += 5;
        
        return Math.min(100, score);
    }

    scoreAge(createdAt) {
        const ageMinutes = (Date.now() - createdAt) / (1000 * 60);
        
        if (ageMinutes < 5) return 100;
        if (ageMinutes < 30) return 90;
        if (ageMinutes < 60) return 80;
        if (ageMinutes < 180) return 60;
        if (ageMinutes < 360) return 40;
        if (ageMinutes < 720) return 20;
        return 10;
    }

    scoreVolume(volume, liquidity) {
        if (!liquidity || liquidity === 0) return 0;
        const ratio = volume / liquidity;
        
        if (ratio > 5) return 100;
        if (ratio > 2) return 80;
        if (ratio > 1) return 60;
        if (ratio > 0.5) return 40;
        if (ratio > 0.1) return 20;
        return 10;
    }

    calculateRiskScore(token, analysis) {
        let risk = 40;
        
        if (token.liquidity < 5000) risk += 20;
        else if (token.liquidity < 10000) risk += 10;
        
        if (Math.abs(token.priceChange24h || 0) > 200) risk += 20;
        else if (Math.abs(token.priceChange24h || 0) > 100) risk += 10;
        
        const ageMinutes = (Date.now() - token.createdAt) / (1000 * 60);
        if (ageMinutes < 10) risk += 20;
        else if (ageMinutes < 30) risk += 15;
        else if (ageMinutes < 60) risk += 10;
        
        // Lower risk for trusted sources
        if (['pumpfun', 'moonshot'].includes(token.source)) risk -= 10;
        
        const avgScore = (analysis.liquidityScore + analysis.momentumScore + 
                         analysis.ageScore + analysis.volumeScore) / 4;
        if (avgScore < 40) risk += 15;
        
        return Math.min(100, Math.max(0, risk));
    }

    // Get top movers across all sources
    async getTopMovers(limit = 20) {
        const allTokens = [];

        for (const scanner of Object.values(this.scanners)) {
            if (scanner.tokens) {
                allTokens.push(...Array.from(scanner.tokens.values()));
            }
        }

        return allTokens
            .sort((a, b) => {
                const aScore = (a.priceChange24h || 0) * (a.volume24h || 0);
                const bScore = (b.priceChange24h || 0) * (b.volume24h || 0);
                return bScore - aScore;
            })
            .slice(0, limit);
    }

    // Get scanner status
    getScannerStatus() {
        const status = {};
        
        for (const [name, scanner] of Object.entries(this.scanners)) {
            status[name] = {
                enabled: this.scannerConfigs[name]?.enabled || false,
                running: scanner.isRunning || false,
                tokensFound: scanner.tokens?.size || 0,
                lastUpdate: scanner.lastFetch || null,
                rateLimit: this.rateLimits[name] ? {
                    used: this.rateLimits[name].current,
                    max: this.rateLimits[name].max,
                    resetsIn: Math.max(0, this.rateLimits[name].reset - Date.now())
                } : null
            };
        }
        
        return status;
    }

    stopScanning() {
        this.isScanning = false;
        
        // Stop all scanner intervals
        for (const scanner of Object.values(this.scanners)) {
            if (scanner.interval) {
                clearInterval(scanner.interval);
            }
            scanner.isRunning = false;
        }
        
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        
        logger.info('Multi-source token scanner stopped');
    }
}

module.exports = MultiSourceTokenScanner;