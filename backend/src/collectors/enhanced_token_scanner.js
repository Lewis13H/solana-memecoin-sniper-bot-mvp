// backend/src/collectors/enhanced_token_scanner.js
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../utils/logger');

class EnhancedTokenScanner {
    constructor(database) {
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL
        );
        this.isScanning = false;
        this.scanInterval = 15000; // 15 seconds for faster discovery
        this.processedTokens = new Set();
        this.processedPools = new Set();
        
        // Raydium Program IDs
        this.RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        this.RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    }

    async startScanning() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        logger.info('🚀 Enhanced Token Scanner started with Raydium monitoring');

        // Initial scan
        await this.scanAll();

        // Continuous scanning
        this.scanTimer = setInterval(async () => {
            try {
                await this.scanAll();
            } catch (error) {
                logger.error('Scanner error:', error);
            }
        }, this.scanInterval);

        // Real-time Raydium monitoring
        if (process.env.HELIUS_API_KEY) {
            this.startRaydiumWebsocket();
        }
    }

    async scanAll() {
        const [dexScreenerTokens, birdeyeTokens, raydiumPools] = await Promise.all([
            this.fetchDexScreenerTokens(),
            this.fetchBirdeyeTokens(),
            this.fetchRecentRaydiumPools()
        ]);

        const allTokens = [...dexScreenerTokens, ...birdeyeTokens, ...raydiumPools];
        const uniqueTokens = this.deduplicateTokens(allTokens);
        const newTokens = uniqueTokens.filter(t => !this.processedTokens.has(t.address));

        logger.info(`Found ${newTokens.length} new tokens to analyze`);

        for (const token of newTokens) {
            await this.analyzeAndStoreToken(token);
            this.processedTokens.add(token.address);
        }
    }

    async fetchBirdeyeTokens() {
        if (!process.env.BIRDEYE_API_KEY) return [];

        try {
            const response = await axios.get(
                'https://public-api.birdeye.so/defi/tokenlist',
                {
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
                }
            );

            return response.data.data.tokens
                .filter(token => {
                    const age = Date.now() - (token.createTime * 1000);
                    return (
                        age < 24 * 60 * 60 * 1000 && // Less than 24 hours old
                        token.liquidity > parseFloat(process.env.MIN_LIQUIDITY || 500) &&
                        token.v24hChangePercent > 0 // Positive momentum
                    );
                })
                .map(token => ({
                    address: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    price: token.price,
                    liquidity: token.liquidity,
                    volume24h: token.v24hUSD,
                    priceChange24h: token.v24hChangePercent,
                    marketCap: token.mc,
                    createdAt: token.createTime * 1000,
                    source: 'birdeye'
                }));
        } catch (error) {
            logger.warn('Birdeye fetch error:', error.message);
            return [];
        }
    }

    async fetchRecentRaydiumPools() {
        try {
            // Get recent signatures for Raydium
            const signatures = await this.connection.getSignaturesForAddress(
                this.RAYDIUM_V4,
                { limit: 100 }
            );

            const recentPools = [];
            
            for (const sig of signatures.slice(0, 20)) { // Check last 20 transactions
                try {
                    const tx = await this.connection.getParsedTransaction(
                        sig.signature,
                        { maxSupportedTransactionVersion: 0 }
                    );

                    if (!tx || !tx.meta) continue;

                    // Look for pool initialization
                    const instructions = tx.transaction.message.instructions;
                    
                    for (const ix of instructions) {
                        if (ix.programId.toString() === this.RAYDIUM_V4.toString()) {
                            const poolInfo = await this.parseRaydiumPoolCreation(tx);
                            if (poolInfo && !this.processedPools.has(poolInfo.poolId)) {
                                recentPools.push(poolInfo);
                                this.processedPools.add(poolInfo.poolId);
                                logger.info(`🎯 New Raydium pool detected: ${poolInfo.symbol}`);
                            }
                        }
                    }
                } catch (error) {
                    // Continue with next transaction
                }
            }

            return recentPools;
        } catch (error) {
            logger.warn('Raydium monitoring error:', error.message);
            return [];
        }
    }

    async parseRaydiumPoolCreation(transaction) {
        try {
            // Extract token addresses from the transaction
            const accounts = transaction.transaction.message.accountKeys;
            
            // Raydium pool typically has specific account structure
            if (accounts.length < 10) return null;

            // Get the token mint addresses (usually at specific indices)
            const tokenAMint = accounts[8]?.pubkey?.toString();
            const tokenBMint = accounts[9]?.pubkey?.toString();

            if (!tokenAMint || !tokenBMint) return null;

            // Check if one is SOL/WSOL
            const WSOL = 'So11111111111111111111111111111111111111112';
            const isSOLPair = tokenAMint === WSOL || tokenBMint === WSOL;
            
            if (!isSOLPair) return null;

            const tokenMint = tokenAMint === WSOL ? tokenBMint : tokenAMint;

            // Get token info
            const tokenInfo = await this.getTokenInfo(tokenMint);
            if (!tokenInfo) return null;

            return {
                address: tokenMint,
                symbol: tokenInfo.symbol || 'UNKNOWN',
                name: tokenInfo.name || 'Unknown Token',
                poolId: transaction.transaction.signatures[0],
                liquidity: 1000, // Will be updated by price fetcher
                volume24h: 0,
                priceChange24h: 0,
                marketCap: 0,
                createdAt: Date.now(),
                source: 'raydium-direct',
                isNew: true
            };
        } catch (error) {
            return null;
        }
    }

    async getTokenInfo(mintAddress) {
        try {
            // Try to get from Birdeye first
            if (process.env.BIRDEYE_API_KEY) {
                const response = await axios.get(
                    `https://public-api.birdeye.so/defi/token_overview`,
                    {
                        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY },
                        params: { address: mintAddress },
                        timeout: 5000
                    }
                );
                
                if (response.data.data) {
                    return {
                        symbol: response.data.data.symbol,
                        name: response.data.data.name,
                        decimals: response.data.data.decimals
                    };
                }
            }

            // Fallback to on-chain data
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            
            if (mintInfo.value?.data?.parsed?.info) {
                return {
                    symbol: 'NEW',
                    name: 'New Token',
                    decimals: mintInfo.value.data.parsed.info.decimals
                };
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    startRaydiumWebsocket() {
        logger.info('🔌 Starting Raydium WebSocket monitoring');
        
        // Subscribe to Raydium program logs
        this.connection.onLogs(
            this.RAYDIUM_V4,
            async (logs) => {
                if (logs.err) return;
                
                // Check if this is a pool creation
                const isPoolCreation = logs.logs.some(log => 
                    log.includes('InitializeInstruction') || 
                    log.includes('Initialize2')
                );

                if (isPoolCreation) {
                    logger.info('🆕 Real-time Raydium pool creation detected!');
                    
                    // Fetch and analyze the transaction
                    try {
                        const tx = await this.connection.getParsedTransaction(
                            logs.signature,
                            { maxSupportedTransactionVersion: 0 }
                        );
                        
                        const poolInfo = await this.parseRaydiumPoolCreation(tx);
                        if (poolInfo) {
                            await this.analyzeAndStoreToken(poolInfo);
                            this.processedTokens.add(poolInfo.address);
                        }
                    } catch (error) {
                        logger.error('Error processing real-time pool:', error);
                    }
                }
            },
            'confirmed'
        );
    }

    deduplicateTokens(tokens) {
        const uniqueMap = new Map();
        
        for (const token of tokens) {
            if (!uniqueMap.has(token.address) || token.source === 'raydium-direct') {
                uniqueMap.set(token.address, token);
            }
        }
        
        return Array.from(uniqueMap.values());
    }

    async fetchDexScreenerTokens() {
        try {
            const response = await axios.get(
                'https://api.dexscreener.com/latest/dex/search',
                { 
                    params: { q: 'SOL' },
                    timeout: 10000 
                }
            );

            if (!response.data || !response.data.pairs) {
                return [];
            }

            return response.data.pairs
                .filter(pair => {
                    if (!pair || !pair.baseToken) return false;
                    
                    const age = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity;
                    const liquidity = pair.liquidity?.usd || 0;
                    const volume = pair.volume?.h24 || 0;
                    
                    return (
                        pair.chainId === 'solana' &&
                        age < 24 * 60 * 60 * 1000 &&
                        liquidity >= parseFloat(process.env.MIN_LIQUIDITY || 500) &&
                        volume > 100
                    );
                })
                .map(pair => ({
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
                    source: 'dexscreener'
                }))
                .slice(0, 50);
        } catch (error) {
            logger.error('DexScreener fetch error:', error.message);
            return [];
        }
    }

    // Enhanced analysis with source weighting
    async analyzeAndStoreToken(token) {
        try {
            // Give bonus points for Raydium discoveries
            const sourceBonus = token.source === 'raydium-direct' ? 20 : 0;
            
            const analysis = {
                liquidityScore: this.scoreLiquidity(token.liquidity),
                momentumScore: this.scoreMomentum(token.priceChange24h || 0, token.volume24h),
                ageScore: this.scoreAge(token.createdAt) + sourceBonus,
                volumeScore: this.scoreVolume(token.volume24h, token.liquidity)
            };

            const overallScore = (
                analysis.liquidityScore * 0.25 +
                analysis.momentumScore * 0.25 +
                analysis.ageScore * 0.3 +
                analysis.volumeScore * 0.2
            );

            const riskScore = this.calculateRiskScore(token, analysis);

            // Lower threshold for Raydium discoveries
            const scoreThreshold = token.source === 'raydium-direct' ? 20 : 30;
            
            if (overallScore > scoreThreshold && riskScore < 85) {
                await this.db.addToken({
                    address: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    marketCap: token.marketCap,
                    liquidity: token.liquidity,
                    holders: 0,
                    socialScore: token.isNew ? 10 : 0, // Base score for new tokens
                    riskScore: riskScore
                });

                logger.info(`✅ Added token: ${token.symbol} from ${token.source} (Score: ${overallScore.toFixed(1)}, Risk: ${riskScore.toFixed(1)})`);
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
        
        if (ageMinutes < 5) return 100;    // Ultra fresh
        if (ageMinutes < 30) return 90;    // Very fresh
        if (ageMinutes < 60) return 80;    // Fresh
        if (ageMinutes < 180) return 60;   // Recent
        if (ageMinutes < 360) return 40;   // Few hours old
        if (ageMinutes < 720) return 20;   // Half day old
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
        let risk = 40; // Base risk
        
        if (token.liquidity < 5000) risk += 20;
        else if (token.liquidity < 10000) risk += 10;
        
        if (Math.abs(token.priceChange24h || 0) > 200) risk += 20;
        else if (Math.abs(token.priceChange24h || 0) > 100) risk += 10;
        
        const ageMinutes = (Date.now() - token.createdAt) / (1000 * 60);
        if (ageMinutes < 10) risk += 20;
        else if (ageMinutes < 30) risk += 15;
        else if (ageMinutes < 60) risk += 10;
        
        // Lower risk for established DEXs
        if (token.source === 'dexscreener' && token.dexId === 'raydium') risk -= 5;
        if (token.source === 'birdeye') risk -= 5;
        
        const avgScore = (analysis.liquidityScore + analysis.momentumScore + 
                         analysis.ageScore + analysis.volumeScore) / 4;
        if (avgScore < 40) risk += 15;
        
        return Math.min(100, Math.max(0, risk));
    }

    stopScanning() {
        this.isScanning = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        logger.info('Enhanced token scanner stopped');
    }
}

module.exports = EnhancedTokenScanner;