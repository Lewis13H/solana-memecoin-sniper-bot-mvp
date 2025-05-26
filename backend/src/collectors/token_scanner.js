const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../utils/logger');

class TokenScanner {
    constructor(database) {
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL
        );
        this.isScanning = false;
        this.scanInterval = 30000; // 30 seconds
        this.processedTokens = new Set();
    }

    async startScanning() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        logger.info('🚀 Token scanner started');

        // Add test token on first run
        if (this.processedTokens.size === 0) {
            await this.addTestToken();
        }

        // Initial scan
        await this.scanNewTokens();

        // Continuous scanning
        this.scanTimer = setInterval(async () => {
            try {
                await this.scanNewTokens();
            } catch (error) {
                logger.error('Scanner error:', error);
            }
        }, this.scanInterval);
    }

    async scanNewTokens() {
        try {
            // Multiple data sources for better coverage
            const [dexScreenerTokens, raydiumTokens, birdeyeTokens] = await Promise.all([
                this.fetchDexScreenerTokens(),
                this.fetchRadyiumNewPools(),
                this.fetchBirdeyeTokens()
            ]);

            const allTokens = [...dexScreenerTokens, ...raydiumTokens, ...birdeyeTokens];
            const newTokens = allTokens.filter(t => !this.processedTokens.has(t.address));

            logger.info(`Found ${newTokens.length} new tokens to analyze`);

            for (const token of newTokens) {
                await this.analyzeAndStoreToken(token);
                this.processedTokens.add(token.address);
            }

        } catch (error) {
            logger.error('Error in token scanning:', error);
        }
    }

    async fetchDexScreenerTokens() {
        try {
            // Use the trending tokens endpoint first
            const response = await axios.get(
                'https://api.dexscreener.com/token-boosts/latest/v1',
                { timeout: 10000 }
            );

            // If that doesn't work, try search endpoint
            if (!response.data || response.data.length === 0) {
                const searchResponse = await axios.get(
                    'https://api.dexscreener.com/latest/dex/search?q=SOL',
                    { timeout: 10000 }
                );
                
                if (!searchResponse.data || !searchResponse.data.pairs) {
                    logger.warn('DexScreener returned no data');
                    return [];
                }

                return this.processPairs(searchResponse.data.pairs);
            }

            // Process boosted tokens
            const tokens = [];
            for (const boost of response.data.slice(0, 20)) {
                try {
                    const tokenResponse = await axios.get(
                        `https://api.dexscreener.com/latest/dex/tokens/${boost.tokenAddress}`,
                        { timeout: 5000 }
                    );
                    
                    if (tokenResponse.data?.pairs) {
                        tokens.push(...this.processPairs(tokenResponse.data.pairs));
                    }
                } catch (err) {
                    // Continue with next token
                }
            }

            return tokens;
        } catch (error) {
            logger.error('DexScreener fetch error:', error.message);
            return [];
        }
    }

    // Helper method to process pairs
    processPairs(pairs) {
        return pairs
            .filter(pair => {
                const age = Date.now() - pair.pairCreatedAt;
                return (
                    pair.chainId === 'solana' &&
                    pair.liquidity?.usd >= parseFloat(process.env.MIN_LIQUIDITY || 1000) &&
                    age < 24 * 60 * 60 * 1000 && // Changed to 24 hours for testing
                    pair.volume?.h24 > 100 // Lowered for testing
                );
            })
            .map(pair => ({
                address: pair.baseToken.address,
                symbol: pair.baseToken.symbol,
                name: pair.baseToken.name,
                price: parseFloat(pair.priceUsd || 0),
                liquidity: parseFloat(pair.liquidity?.usd || 0),
                volume24h: parseFloat(pair.volume?.h24 || 0),
                priceChange1h: parseFloat(pair.priceChange?.h1 || 0),
                marketCap: parseFloat(pair.fdv || 0),
                pairAddress: pair.pairAddress,
                dexId: pair.dexId,
                createdAt: pair.pairCreatedAt
            }))
            .slice(0, 50);
    }

    async fetchRadyiumNewPools() {
        // Raydium-specific monitoring for earliest detection
        try {
            if (!process.env.HELIUS_API_KEY) return [];

            const response = await axios.post(
                `https://api.helius.xyz/v0/addresses/transactions?api-key=${process.env.HELIUS_API_KEY}`,
                {
                    addresses: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'], // Raydium V4
                    type: 'SWAP_INITIALIZE'
                }
            );

            // Parse new pool creations
            return this.parseRadyiumTransactions(response.data);
        } catch (error) {
            logger.warn('Raydium monitoring unavailable');
            return [];
        }
    }

    async fetchBirdeyeTokens() {
    try {
        const response = await axios.get(
            'https://public-api.birdeye.so/defi/tokenlist',
            {
                params: {
                    chain: 'solana',
                    sort_by: 'v24hUSD',
                    sort_type: 'desc',
                    offset: 0,
                    limit: 50
                },
                headers: {
                    'Accept': 'application/json',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY || ''  // Add API key header
                },
                timeout: 10000
            }
        );

        if (!response.data?.data?.tokens) {
            return [];
        }

        return response.data.data.tokens
            .filter(token => {
                const age = Date.now() - (token.createdAt * 1000);
                return (
                    token.liquidity >= parseFloat(process.env.MIN_LIQUIDITY || 1000) &&
                    age < 24 * 60 * 60 * 1000 && // 24 hours
                    token.v24hUSD > 100
                );
            })
            .map(token => ({
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                price: token.price,
                liquidity: token.liquidity,
                volume24h: token.v24hUSD,
                priceChange1h: token.v1hChangePercent || 0,
                marketCap: token.mc,
                createdAt: token.createdAt * 1000
            }));
    } catch (error) {
        logger.warn('Birdeye fetch failed:', error.message);
        return [];
    }
}

    // Add this method for testing
    async addTestToken() {
        const testToken = {
            address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK for testing
            symbol: 'BONK',
            name: 'Bonk',
            price: 0.00002102,
            liquidity: 1000000,
            volume24h: 1000000,
            priceChange1h: 5.5,
            marketCap: 1868203531,
            createdAt: Date.now() - (2 * 60 * 60 * 1000) // 2 hours ago
        };

        await this.analyzeAndStoreToken(testToken);
        logger.info('Added test token BONK for testing');
    }

    parseRadyiumTransactions(transactions) {
        // Simplified for MVP - would need full implementation
        return [];
    }

    async analyzeAndStoreToken(token) {
        try {
            // Calculate risk and opportunity scores
            const analysis = {
                liquidityScore: this.scoreLiquidity(token.liquidity),
                momentumScore: this.scoreMomentum(token.priceChange1h, token.volume24h),
                ageScore: this.scoreAge(token.createdAt),
                volumeScore: this.scoreVolume(token.volume24h, token.liquidity)
            };

            const overallScore = (
                analysis.liquidityScore * 0.3 +
                analysis.momentumScore * 0.3 +
                analysis.ageScore * 0.2 +
                analysis.volumeScore * 0.2
            );

            const riskScore = this.calculateRiskScore(token, analysis);

            // Store if meets minimum criteria
            if (overallScore > 30 && riskScore < 80) {
                await this.db.addToken({
                    address: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    marketCap: token.marketCap,
                    liquidity: token.liquidity,
                    holders: 0, // Will update from chain
                    socialScore: 0, // Will be updated by social monitor
                    riskScore: riskScore
                });

                logger.info(`✅ Added token: ${token.symbol} (Score: ${overallScore.toFixed(1)}, Risk: ${riskScore.toFixed(1)})`);
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
        return 20;
    }

    scoreMomentum(priceChange1h, volume24h) {
        let score = 50;
        
        // Price momentum
        if (priceChange1h > 50) score += 30;
        else if (priceChange1h > 20) score += 20;
        else if (priceChange1h > 10) score += 10;
        
        // Volume momentum
        if (volume24h > 100000) score += 20;
        else if (volume24h > 50000) score += 15;
        else if (volume24h > 10000) score += 10;
        
        return Math.min(100, score);
    }

    scoreAge(createdAt) {
        const ageMinutes = (Date.now() - createdAt) / (1000 * 60);
        
        if (ageMinutes < 30) return 100;  // First 30 minutes
        if (ageMinutes < 60) return 80;   // First hour
        if (ageMinutes < 180) return 60;  // First 3 hours
        if (ageMinutes < 360) return 40;  // First 6 hours
        return 20;
    }

    scoreVolume(volume, liquidity) {
        const ratio = volume / liquidity;
        
        if (ratio > 5) return 100;   // Very high volume
        if (ratio > 2) return 80;    // High volume
        if (ratio > 1) return 60;    // Good volume
        if (ratio > 0.5) return 40;  // Moderate volume
        return 20;
    }

    calculateRiskScore(token, analysis) {
        let risk = 50; // Base risk
        
        // Lower liquidity = higher risk
        if (token.liquidity < 10000) risk += 20;
        else if (token.liquidity < 25000) risk += 10;
        
        // Extreme price movements = higher risk
        if (Math.abs(token.priceChange1h) > 100) risk += 20;
        else if (Math.abs(token.priceChange1h) > 50) risk += 10;
        
        // Very new = higher risk
        const ageMinutes = (Date.now() - token.createdAt) / (1000 * 60);
        if (ageMinutes < 30) risk += 15;
        else if (ageMinutes < 60) risk += 10;
        
        // Low score = higher risk
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
        logger.info('Token scanner stopped');
    }
}

module.exports = TokenScanner;