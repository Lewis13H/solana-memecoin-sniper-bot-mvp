// backend/src/collectors/scanners/jupiter_scanner.js
const EventEmitter = require('events');
const axios = require('axios');
const logger = require('../../utils/logger');

class JupiterScanner extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.tokens = new Map();
        this.lastUpdate = null;
        this.scanInterval = 60000; // 60 seconds (less frequent as Jupiter aggregates data)
        
        this.config = {
            enabled: true,
            jupiterApiUrl: 'https://token.jup.ag',
            priceApiUrl: 'https://price.jup.ag/v4',
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || 500),
            minVolume24h: 1000
        };
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🪐 Jupiter scanner started');
        
        // Initial scan
        await this.scanTokens();
        
        // Set up periodic scanning
        this.scanTimer = setInterval(() => {
            this.scanTokens();
        }, this.scanInterval);
    }

    async scanTokens() {
        try {
            // Get all verified tokens from Jupiter
            const allTokensResponse = await axios.get(
                `${this.config.jupiterApiUrl}/all`,
                { timeout: 10000 }
            );

            if (!allTokensResponse.data || allTokensResponse.data.length === 0) {
                logger.warn('No tokens returned from Jupiter API');
                return;
            }

            // Sort by creation time (if available) or by liquidity
            const tokens = allTokensResponse.data;
            
            // Get recently active tokens
            const recentTokens = await this.filterRecentTokens(tokens);
            
            // Process each token
            for (const token of recentTokens) {
                if (!this.tokens.has(token.address)) {
                    const enrichedToken = await this.enrichTokenData(token);
                    
                    if (enrichedToken && 
                        enrichedToken.liquidity >= this.config.minLiquidity &&
                        enrichedToken.volume24h >= this.config.minVolume24h) {
                        
                        this.tokens.set(token.address, enrichedToken);
                        this.emit('token', enrichedToken);
                        
                        logger.info(`🪐 New Jupiter token: ${enrichedToken.symbol} - ${enrichedToken.address}`);
                    }
                }
            }

            this.lastUpdate = Date.now();
        } catch (error) {
            logger.error('Jupiter scanning error:', error.message);
            this.emit('error', error);
        }
    }

    async filterRecentTokens(tokens) {
        try {
            // Get price data for tokens to identify active ones
            const tokenAddresses = tokens.slice(0, 100).map(t => t.address).join(',');
            
            const priceResponse = await axios.get(
                `${this.config.priceApiUrl}/price?ids=${tokenAddresses}`,
                { timeout: 10000 }
            );

            const priceData = priceResponse.data?.data || {};
            
            // Filter tokens with recent price updates and activity
            const recentTokens = tokens.filter(token => {
                const price = priceData[token.address];
                if (!price) return false;
                
                // Check if price was updated recently (within 24 hours)
                const lastUpdate = price.updateTs || 0;
                const isRecent = (Date.now() - lastUpdate) < 24 * 60 * 60 * 1000;
                
                // Check if there's significant activity
                const hasActivity = price.volume24h > this.config.minVolume24h;
                
                return isRecent && hasActivity;
            });

            return recentTokens.slice(0, 50); // Limit to top 50 active tokens
        } catch (error) {
            logger.error('Error filtering recent tokens:', error.message);
            return tokens.slice(0, 20); // Fallback to first 20 tokens
        }
    }

    async enrichTokenData(token) {
        try {
            // Get detailed price and market data
            const priceResponse = await axios.get(
                `${this.config.priceApiUrl}/price?ids=${token.address}`,
                { timeout: 5000 }
            );

            const priceData = priceResponse.data?.data?.[token.address];
            
            if (!priceData) {
                return null;
            }

            // Get additional market stats if available
            const marketStats = await this.getMarketStats(token.address);

            const enriched = {
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                price: priceData.price || 0,
                volume24h: priceData.volume24h || 0,
                liquidity: marketStats?.liquidity || this.estimateLiquidity(priceData),
                marketCap: priceData.price * (token.supply || 0),
                priceChange24h: ((priceData.price - (priceData.price24hAgo || priceData.price)) / (priceData.price24hAgo || priceData.price)) * 100,
                createdAt: token.createdAt || Date.now() - (7 * 24 * 60 * 60 * 1000), // Default to 7 days ago
                verified: true, // Jupiter only lists verified tokens
                logoUri: token.logoURI,
                tags: token.tags || [],
                platform: 'jupiter',
                dexes: marketStats?.dexes || ['jupiter-aggregated']
            };

            return enriched;
        } catch (error) {
            logger.debug(`Failed to enrich Jupiter token ${token.address}:`, error.message);
            return null;
        }
    }

    async getMarketStats(tokenAddress) {
        try {
            // Get route info to determine liquidity sources
            const routeResponse = await axios.get(
                `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=1000000000`,
                { timeout: 5000 }
            );

            if (routeResponse.data && routeResponse.data.routePlan) {
                const routes = routeResponse.data.routePlan;
                const dexes = [...new Set(routes.map(r => r.swapInfo.label))];
                
                // Estimate total liquidity from available routes
                const totalLiquidity = routes.reduce((sum, route) => {
                    return sum + (route.swapInfo.liquidityAvailable || 0);
                }, 0);

                return {
                    liquidity: totalLiquidity,
                    dexes: dexes,
                    routeCount: routes.length
                };
            }
        } catch (error) {
            logger.debug('Failed to get market stats:', error.message);
        }

        return null;
    }

    estimateLiquidity(priceData) {
        // Rough liquidity estimation based on volume
        // Higher volume typically indicates better liquidity
        const volumeToLiquidityRatio = 0.1; // Assume liquidity is ~10% of daily volume
        return (priceData.volume24h || 0) * volumeToLiquidityRatio;
    }

    async stop() {
        this.isRunning = false;
        
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        
        logger.info('Jupiter scanner stopped');
    }
}

module.exports = JupiterScanner;