// backend/src/collectors/scanners/orca_scanner.js
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class OrcaScanner extends EventEmitter {
    constructor(config, parent) {
        super();
        this.config = config.sources.orca;
        this.parent = parent;
        this.connection = parent.connection;
        this.tokens = new Map();
        this.pools = new Map();
        this.isRunning = false;
        this.whirlpoolProgram = new PublicKey(this.config.programId);
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🌊 Starting Orca scanner');
        
        // Initial fetch
        await this.fetchPools();
        
        // Monitor for new pools
        this.subscribeToWhirlpool();
        
        // Periodic fetch
        this.fetchInterval = setInterval(() => {
            this.fetchPools();
        }, 45000); // Every 45 seconds
    }

    async fetchPools() {
        try {
            const response = await axios.get(
                `${this.config.api.base}${this.config.api.endpoints.pools}`,
                {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.whirlpools) {
                const newPools = response.data.whirlpools
                    .filter(pool => this.isNewPool(pool))
                    .filter(pool => this.isValidPool(pool));

                for (const pool of newPools) {
                    const tokens = this.extractTokensFromPool(pool);
                    
                    for (const token of tokens) {
                        if (!this.tokens.has(token.address)) {
                            this.tokens.set(token.address, token);
                            this.emit('token', token);
                        }
                    }
                }

                logger.info(`🌊 Orca: Processed ${newPools.length} new pools`);
            }
        } catch (error) {
            logger.error('Orca API error:', error.message);
        }
    }

    subscribeToWhirlpool() {
        // Monitor Whirlpool program for new pool creation
        this.connection.onLogs(
            this.whirlpoolProgram,
            async (logs) => {
                if (logs.err) return;
                
                if (this.isPoolCreation(logs)) {
                    const poolData = await this.parsePoolCreation(logs.signature);
                    if (poolData) {
                        const tokens = this.extractTokensFromPool(poolData);
                        
                        for (const token of tokens) {
                            this.emit('token', { ...token, priority: 85 });
                            logger.info(`🌊 Orca: New pool with ${token.symbol} detected!`);
                        }
                    }
                }
            },
            'confirmed'
        );
    }

    isPoolCreation(logs) {
        return logs.logs.some(log => 
            log.includes('InitializePool') || 
            log.includes('CreateWhirlpool') ||
            log.includes('InitializeConfig')
        );
    }

    async parsePoolCreation(signature) {
        try {
            const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta) return null;

            // Extract pool data from transaction
            // This is simplified - actual implementation would parse Whirlpool instructions
            return null; // Placeholder
        } catch (error) {
            logger.error('Error parsing Orca transaction:', error);
            return null;
        }
    }

    isNewPool(pool) {
        // Check if we've seen this pool before
        if (this.pools.has(pool.address)) return false;
        
        // Check age
        const createdAt = pool.createdAt || pool.timestamp;
        const age = Date.now() - createdAt;
        
        // Only process pools less than 24 hours old
        return age < 24 * 60 * 60 * 1000;
    }

    isValidPool(pool) {
        // Must have minimum liquidity
        const liquidity = parseFloat(pool.tvl || pool.liquidity || 0);
        if (liquidity < 1000) return false; // $1000 minimum
        
        // Must have valid tokens
        if (!pool.tokenA || !pool.tokenB) return false;
        
        return true;
    }

    extractTokensFromPool(pool) {
        const tokens = [];
        const WSOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
        
        // Common stablecoins and SOL to filter out
        const commonTokens = [WSOL, USDC, USDT];
        
        // Extract tokenA if it's not a common token
        if (pool.tokenA && !commonTokens.includes(pool.tokenA.mint)) {
            tokens.push(this.formatToken(pool.tokenA, pool));
        }
        
        // Extract tokenB if it's not a common token
        if (pool.tokenB && !commonTokens.includes(pool.tokenB.mint)) {
            tokens.push(this.formatToken(pool.tokenB, pool));
        }
        
        // Mark pool as processed
        this.pools.set(pool.address, true);
        
        return tokens;
    }

    formatToken(tokenData, poolData) {
        // Calculate price based on pool reserves
        const price = this.calculateTokenPrice(tokenData, poolData);
        
        return {
            address: tokenData.mint || tokenData.address,
            symbol: tokenData.symbol || 'UNKNOWN',
            name: tokenData.name || tokenData.symbol,
            price: price,
            priceUsd: price * this.getSolPrice(),
            liquidity: parseFloat(poolData.tvl || poolData.liquidity || 0) / 2, // Half of pool TVL
            volume24h: parseFloat(poolData.volume24h || 0),
            marketCap: 0, // Would need to fetch supply
            holders: 0, // Would need to fetch from chain
            createdAt: poolData.createdAt || poolData.timestamp || Date.now(),
            priceChange24h: parseFloat(poolData.priceChange24h || 0),
            
            // Orca specific
            poolAddress: poolData.address,
            poolTvl: parseFloat(poolData.tvl || 0),
            poolApr: parseFloat(poolData.apr || 0),
            feeTier: poolData.fee || poolData.feeTier,
            
            // Price range for concentrated liquidity
            priceRange: {
                lower: poolData.priceLower,
                upper: poolData.priceUpper,
                current: poolData.currentPrice
            },
            
            metadata: {
                verified: poolData.verified || false,
                logo: tokenData.logo || tokenData.logoURI
            },
            
            source: 'orca',
            sourceData: {
                poolType: 'whirlpool',
                tickSpacing: poolData.tickSpacing,
                liquidity: poolData.liquidity
            }
        };
    }

    calculateTokenPrice(tokenData, poolData) {
        // Simple price calculation from reserves
        // In reality, this would use Orca's math for concentrated liquidity
        if (poolData.tokenA?.mint === tokenData.mint) {
            return parseFloat(poolData.price || 0);
        } else {
            return poolData.price ? 1 / parseFloat(poolData.price) : 0;
        }
    }

    getSolPrice() {
        // In production, fetch this from a price feed
        return 150; // Placeholder
    }

    stop() {
        this.isRunning = false;
        
        if (this.fetchInterval) {
            clearInterval(this.fetchInterval);
        }
        
        logger.info('Orca scanner stopped');
    }
}

module.exports = OrcaScanner;