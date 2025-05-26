// backend/src/collectors/multi_source_token_scanner.js
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const config = require('../config/scanner-sources');

class MultiSourceTokenScanner extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta')
        );
        
        this.isScanning = false;
        this.scanInterval = 15000; // 15 seconds
        this.processedTokens = new Set();
        this.scanners = new Map();
        
        // Pass configuration to scanners
        this.scannerConfig = config;
        
        // Initialize individual scanners
        this.initializeScanners();
    }

    initializeScanners() {
        // Only initialize enabled scanners
        if (config.scanners.pumpfun.enabled) {
            this.scanners.set('pumpfun', new PumpFunScanner(this.scannerConfig));
        }
        
        if (config.scanners.moonshot.enabled) {
            this.scanners.set('moonshot', new MoonshotScanner(this.scannerConfig));
        }
        
        if (config.scanners.raydium.enabled) {
            this.scanners.set('raydium', new RaydiumScanner(this.scannerConfig, this.connection));
        }
        
        if (config.scanners.dexscreener.enabled) {
            this.scanners.set('dexscreener', new DexScreenerScanner(this.scannerConfig));
        }
        
        if (config.scanners.birdeye.enabled && process.env.BIRDEYE_API_KEY) {
            this.scanners.set('birdeye', new BirdeyeScanner(this.scannerConfig));
        }

        // Listen to token events from all scanners
        for (const [name, scanner] of this.scanners) {
            scanner.on('token', async (token) => {
                await this.handleNewToken(token, name);
            });
            
            scanner.on('error', (error) => {
                logger.error(`${name} scanner error:`, error);
            });
        }
    }

    async startScanning() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        logger.info('🚀 Multi-source token scanner started');
        
        // Start all individual scanners
        for (const [name, scanner] of this.scanners) {
            try {
                await scanner.start();
                logger.info(`✅ ${name} scanner started`);
            } catch (error) {
                logger.error(`Failed to start ${name} scanner:`, error);
            }
        }
        
        // Start periodic aggregation
        this.aggregationInterval = setInterval(() => {
            this.aggregateAndAnalyze();
        }, this.scanInterval);
    }

    async handleNewToken(token, source) {
        try {
            // Skip if already processed
            if (this.processedTokens.has(token.address)) {
                return;
            }
            
            // Mark as processed
            this.processedTokens.add(token.address);
            
            // Enrich token data
            const enrichedToken = await this.enrichTokenData(token, source);
            
            // Analyze and store
            await this.analyzeAndStoreToken(enrichedToken);
            
        } catch (error) {
            logger.error(`Error handling token from ${source}:`, error);
        }
    }

    async enrichTokenData(token, source) {
        try {
            // Add source and discovery time
            const enriched = {
                ...token,
                source: source,
                discoveredAt: Date.now(),
                priority: config.scanners[source]?.priority || 0
            };
            
            // Get additional data if missing
            if (!enriched.price || !enriched.marketCap) {
                const priceData = await this.fetchTokenPrice(token.address);
                if (priceData) {
                    enriched.price = priceData.price;
                    enriched.marketCap = priceData.marketCap;
                }
            }
            
            return enriched;
            
        } catch (error) {
            logger.error(`Error enriching token data:`, error);
            return token;
        }
    }

    async fetchTokenPrice(tokenAddress) {
        try {
            // Try Jupiter first
            const jupiterResponse = await axios.get(
                `https://price.jup.ag/v4/price?ids=${tokenAddress}`,
                { timeout: 5000 }
            );
            
            if (jupiterResponse.data?.data?.[tokenAddress]) {
                return {
                    price: jupiterResponse.data.data[tokenAddress].price,
                    marketCap: jupiterResponse.data.data[tokenAddress].marketCap?.value
                };
            }
            
            // Fallback to DexScreener
            const dexResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                { timeout: 5000 }
            );
            
            if (dexResponse.data?.pairs?.[0]) {
                const pair = dexResponse.data.pairs[0];
                return {
                    price: parseFloat(pair.priceUsd),
                    marketCap: parseFloat(pair.fdv)
                };
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    async analyzeAndStoreToken(token) {
        try {
            // Calculate scores
            const analysis = {
                liquidityScore: this.scoreLiquidity(token.liquidity || 0),
                momentumScore: this.scoreMomentum(token.priceChange24h || 0, token.volume24h || 0),
                ageScore: this.scoreAge(token.createdAt || Date.now()),
                volumeScore: this.scoreVolume(token.volume24h || 0, token.liquidity || 1),
                sourceScore: token.priority * 10 // Bonus for priority sources
            };

            const overallScore = (
                analysis.liquidityScore * 0.2 +
                analysis.momentumScore * 0.2 +
                analysis.ageScore * 0.2 +
                analysis.volumeScore * 0.2 +
                analysis.sourceScore * 0.2
            );

            const riskScore = this.calculateRiskScore(token, analysis);

            // Store if meets criteria
            if (overallScore > 25 && riskScore < 85) {
                await this.db.addToken({
                    address: token.address,
                    symbol: token.symbol || 'UNKNOWN',
                    name: token.name || 'Unknown Token',
                    marketCap: token.marketCap || 0,
                    liquidity: token.liquidity || 0,
                    holders: token.holders || 0,
                    socialScore: 0,
                    riskScore: riskScore
                });

                logger.info(`✅ Added ${token.symbol} from ${token.source} (Score: ${overallScore.toFixed(1)}, Risk: ${riskScore.toFixed(1)})`);
            }

        } catch (error) {
            logger.error(`Error analyzing token ${token.symbol}:`, error);
        }
    }

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
        
        const ageMinutes = (Date.now() - (token.createdAt || Date.now())) / (1000 * 60);
        if (ageMinutes < 10) risk += 20;
        else if (ageMinutes < 30) risk += 15;
        else if (ageMinutes < 60) risk += 10;
        
        // Reduce risk for trusted sources
        if (['birdeye', 'raydium'].includes(token.source)) risk -= 10;
        
        return Math.min(100, Math.max(0, risk));
    }

    aggregateAndAnalyze() {
        // This method can be used to cross-reference tokens across sources
        const tokensByAddress = new Map();
        
        for (const [source, scanner] of this.scanners) {
            for (const [address, token] of scanner.tokens) {
                if (!tokensByAddress.has(address)) {
                    tokensByAddress.set(address, []);
                }
                tokensByAddress.get(address).push({ source, token });
            }
        }
        
        // Log tokens that appear in multiple sources (higher confidence)
        for (const [address, sources] of tokensByAddress) {
            if (sources.length > 1) {
                const sourceNames = sources.map(s => s.source).join(', ');
                logger.info(`🎯 Token ${sources[0].token.symbol} found on multiple sources: ${sourceNames}`);
            }
        }
    }

    async getTopMovers(limit = 20) {
        const allTokens = [];
        
        for (const [source, scanner] of this.scanners) {
            for (const [address, token] of scanner.tokens) {
                allTokens.push({ ...token, source });
            }
        }
        
        // Sort by score (price change * volume)
        return allTokens
            .sort((a, b) => {
                const scoreA = (a.priceChange24h || 0) * (a.volume24h || 0);
                const scoreB = (b.priceChange24h || 0) * (b.volume24h || 0);
                return scoreB - scoreA;
            })
            .slice(0, limit);
    }

    stopScanning() {
        this.isScanning = false;
        
        // Stop all scanners
        for (const [name, scanner] of this.scanners) {
            scanner.stop();
        }
        
        if (this.aggregationInterval) {
            clearInterval(this.aggregationInterval);
        }
        
        logger.info('Multi-source scanner stopped');
    }
}

// Individual Scanner Implementations

class PumpFunScanner extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.wsUrl = config.scanners.pumpfun.url;
        this.ws = null;
        this.isRunning = false;
        this.tokens = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    connect() {
        try {
            this.ws = new WebSocket(this.wsUrl);
            
            this.ws.on('open', () => {
                logger.info('Connected to Pump.fun WebSocket');
                this.reconnectAttempts = 0;
                
                // Subscribe to new token events
                this.ws.send(JSON.stringify({
                    method: "subscribeNewToken",
                }));
                
                // Subscribe to trades
                this.ws.send(JSON.stringify({
                    method: "subscribeTokenTrade",
                }));
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    logger.error('Error parsing Pump.fun message:', error);
                }
            });

            this.ws.on('error', (error) => {
                logger.error('Pump.fun WebSocket error:', error);
            });

            this.ws.on('close', () => {
                logger.warn('Pump.fun WebSocket closed');
                if (this.isRunning && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
                    logger.info(`Reconnecting to Pump.fun in ${delay}ms...`);
                    setTimeout(() => this.connect(), delay);
                }
            });
        } catch (error) {
            logger.error('Error connecting to Pump.fun:', error);
        }
    }

    handleMessage(message) {
        if (message.txType === 'create') {
            const token = {
                address: message.mint,
                symbol: message.symbol,
                name: message.name,
                decimals: message.decimals || 6,
                liquidity: message.vSolInBondingCurve || 0,
                marketCap: message.marketCapSol || 0,
                createdAt: Date.now(),
                creator: message.traderPublicKey,
                uri: message.uri,
                source: 'pumpfun'
            };
            
            this.tokens.set(token.address, token);
            this.emit('token', token);
        }
        // Handle trade updates
        else if (message.txType === 'buy' || message.txType === 'sell') {
            const existingToken = this.tokens.get(message.mint);
            if (existingToken) {
                existingToken.volume24h = (existingToken.volume24h || 0) + (message.vSolInBondingCurve || 0);
                existingToken.lastUpdate = Date.now();
            }
        }
    }

    stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

class MoonshotScanner extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.programId = config.PROGRAM_IDS.MOONSHOT;
        this.isRunning = false;
        this.tokens = new Map();
        this.checkInterval = 30000; // 30 seconds
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Initial scan
        await this.scanMoonshotTokens();
        
        // Set up periodic scanning
        this.scanTimer = setInterval(async () => {
            if (this.isRunning) {
                await this.scanMoonshotTokens();
            }
        }, this.checkInterval);
    }

    async scanMoonshotTokens() {
        try {
            // Moonshot API endpoint
            const response = await axios.get('https://api.moonshot.cc/tokens/v1/new', {
                params: {
                    limit: 50,
                    offset: 0
                },
                timeout: 10000
            });

            if (response.data && response.data.tokens) {
                for (const token of response.data.tokens) {
                    const formattedToken = {
                        address: token.mintAddress,
                        symbol: token.symbol,
                        name: token.name,
                        liquidity: token.liquidity || 0,
                        marketCap: token.marketCap || 0,
                        volume24h: token.volume24h || 0,
                        priceChange24h: token.priceChange24h || 0,
                        createdAt: new Date(token.createdAt).getTime(),
                        source: 'moonshot'
                    };
                    
                    if (!this.tokens.has(formattedToken.address)) {
                        this.tokens.set(formattedToken.address, formattedToken);
                        this.emit('token', formattedToken);
                    }
                }
            }
        } catch (error) {
            logger.error('Error scanning Moonshot tokens:', error.message);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
    }
}

class RaydiumScanner extends EventEmitter {
    constructor(config, connection) {
        super();
        this.config = config;
        this.connection = connection;
        this.programId = new PublicKey(config.PROGRAM_IDS.RAYDIUM_V4);
        this.isRunning = false;
        this.tokens = new Map();
        this.processedSignatures = new Set();
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Set up real-time monitoring
        this.subscriptionId = this.connection.onLogs(
            this.programId,
            async (logs, context) => {
                if (logs.err === null) {
                    await this.processTransaction(logs.signature);
                }
            },
            'confirmed'
        );
        
        // Also scan recent transactions
        this.scanInterval = setInterval(async () => {
            await this.scanRecentPools();
        }, 30000);
    }

    async processTransaction(signature) {
        if (this.processedSignatures.has(signature)) return;
        this.processedSignatures.add(signature);
        
        try {
            const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });
            
            if (!tx || !tx.meta) return;
            
            // Look for pool initialization
            const poolInfo = await this.parsePoolCreation(tx);
            if (poolInfo) {
                this.tokens.set(poolInfo.address, poolInfo);
                this.emit('token', poolInfo);
            }
        } catch (error) {
            // Transaction parsing errors are common, just log debug
            logger.debug(`Error parsing Raydium transaction ${signature}:`, error.message);
        }
    }

    async parsePoolCreation(transaction) {
        // Implementation would parse the transaction to extract new pool/token info
        // This is a simplified version
        return null; // Would return token info if found
    }

    async scanRecentPools() {
        try {
            const signatures = await this.connection.getSignaturesForAddress(
                this.programId,
                { limit: 50 }
            );
            
            for (const sig of signatures.slice(0, 10)) {
                await this.processTransaction(sig.signature);
            }
        } catch (error) {
            logger.error('Error scanning recent Raydium pools:', error);
        }
    }

    stop() {
        this.isRunning = false;
        
        if (this.subscriptionId) {
            this.connection.removeOnLogsListener(this.subscriptionId);
        }
        
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
    }
}

class DexScreenerScanner extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.isRunning = false;
        this.tokens = new Map();
        this.checkInterval = 20000; // 20 seconds
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        await this.scanTokens();
        
        this.scanTimer = setInterval(async () => {
            if (this.isRunning) {
                await this.scanTokens();
            }
        }, this.checkInterval);
    }

    async scanTokens() {
        try {
            const response = await axios.get(
                'https://api.dexscreener.com/latest/dex/search',
                { 
                    params: { q: 'SOL' },
                    timeout: 10000 
                }
            );

            if (response.data && response.data.pairs) {
                const solanaTokens = response.data.pairs
                    .filter(pair => pair.chainId === 'solana')
                    .slice(0, 50);
                
                for (const pair of solanaTokens) {
                    if (!pair.baseToken) continue;
                    
                    const token = {
                        address: pair.baseToken.address,
                        symbol: pair.baseToken.symbol,
                        name: pair.baseToken.name,
                        price: parseFloat(pair.priceUsd || 0),
                        liquidity: parseFloat(pair.liquidity?.usd || 0),
                        volume24h: parseFloat(pair.volume?.h24 || 0),
                        priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
                        marketCap: parseFloat(pair.fdv || 0),
                        createdAt: pair.pairCreatedAt || Date.now(),
                        source: 'dexscreener'
                    };
                    
                    if (!this.tokens.has(token.address)) {
                        this.tokens.set(token.address, token);
                        this.emit('token', token);
                    }
                }
            }
        } catch (error) {
            logger.error('DexScreener scan error:', error.message);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
    }
}

class BirdeyeScanner extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.apiKey = process.env.BIRDEYE_API_KEY;
        this.isRunning = false;
        this.tokens = new Map();
        this.checkInterval = 30000; // 30 seconds
    }

    async start() {
        if (!this.apiKey) {
            logger.warn('Birdeye API key not configured');
            return;
        }
        
        if (this.isRunning) return;
        this.isRunning = true;
        
        await this.scanTokens();
        
        this.scanTimer = setInterval(async () => {
            if (this.isRunning) {
                await this.scanTokens();
            }
        }, this.checkInterval);
    }

    async scanTokens() {
        try {
            const response = await axios.get(
                'https://public-api.birdeye.so/defi/tokenlist',
                {
                    headers: { 
                        'X-API-KEY': this.apiKey,
                        'x-chain': 'solana'
                    },
                    params: {
                        sort_by: 'v24hUSD',
                        sort_type: 'desc',
                        limit: 50
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.data && response.data.data.tokens) {
                for (const token of response.data.data.tokens) {
                    const formattedToken = {
                        address: token.address,
                        symbol: token.symbol,
                        name: token.name,
                        price: token.price,
                        liquidity: token.liquidity,
                        volume24h: token.v24hUSD,
                        priceChange24h: token.v24hChangePercent,
                        marketCap: token.mc,
                        holders: token.holder,
                        createdAt: token.createTime ? token.createTime * 1000 : Date.now(),
                        source: 'birdeye'
                    };
                    
                    if (!this.tokens.has(formattedToken.address)) {
                        this.tokens.set(formattedToken.address, formattedToken);
                        this.emit('token', formattedToken);
                    }
                }
            }
        } catch (error) {
            logger.error('Birdeye scan error:', error.message);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
    }
}

module.exports = MultiSourceTokenScanner;