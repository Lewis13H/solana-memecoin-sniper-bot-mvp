// backend/src/collectors/scanners/raydium_scanner.js
const EventEmitter = require('events');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../../utils/logger');

class RaydiumScanner extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.tokens = new Map();
        this.processedPools = new Set();
        this.lastUpdate = null;
        this.scanInterval = 20000; // 20 seconds for blockchain monitoring
        
        this.config = {
            enabled: true,
            raydiumV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            raydiumCPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
            raydiumCLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || 500),
            wsol: 'So11111111111111111111111111111111111111112'
        };

        // Initialize Solana connection
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
        );
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🌊 Raydium scanner started');
        
        // Initial scan
        await this.scanRecentPools();
        
        // Set up periodic scanning
        this.scanTimer = setInterval(() => {
            this.scanRecentPools();
        }, this.scanInterval);
        
        // Set up real-time monitoring if Helius is available
        if (process.env.HELIUS_API_KEY) {
            this.setupWebSocketMonitoring();
        }
    }

    async scanRecentPools() {
        try {
            // Get recent signatures for Raydium programs
            const programs = [
                this.config.raydiumV4,
                this.config.raydiumCPMM,
                this.config.raydiumCLMM
            ];

            for (const programId of programs) {
                await this.scanProgramTransactions(programId);
            }

            this.lastUpdate = Date.now();
        } catch (error) {
            logger.error('Raydium scanning error:', error.message);
            this.emit('error', error);
        }
    }

    async scanProgramTransactions(programId) {
        try {
            const signatures = await this.connection.getSignaturesForAddress(
                new PublicKey(programId),
                { limit: 50 }
            );

            for (const sigInfo of signatures) {
                if (this.processedPools.has(sigInfo.signature)) continue;
                
                try {
                    const tx = await this.connection.getParsedTransaction(
                        sigInfo.signature,
                        { maxSupportedTransactionVersion: 0 }
                    );

                    if (tx && tx.meta && !tx.meta.err) {
                        const poolInfo = await this.extractPoolInfo(tx, programId);
                        
                        if (poolInfo && !this.tokens.has(poolInfo.address)) {
                            const enrichedToken = await this.enrichTokenData(poolInfo);
                            
                            if (enrichedToken && enrichedToken.liquidity >= this.config.minLiquidity) {
                                this.tokens.set(poolInfo.address, enrichedToken);
                                this.processedPools.add(sigInfo.signature);
                                this.emit('token', enrichedToken);
                                
                                logger.info(`🌊 New Raydium pool: ${enrichedToken.symbol} - ${enrichedToken.address}`);
                            }
                        }
                    }
                } catch (error) {
                    logger.debug(`Error processing transaction ${sigInfo.signature}:`, error.message);
                }
            }
        } catch (error) {
            logger.error(`Error scanning program ${programId}:`, error.message);
        }
    }

    async extractPoolInfo(transaction, programId) {
        try {
            const instructions = transaction.transaction.message.instructions;
            
            // Find the pool initialization instruction
            for (const ix of instructions) {
                if (ix.programId.toString() === programId) {
                    // Look for pool creation patterns
                    const accounts = transaction.transaction.message.accountKeys;
                    
                    // Extract token mints from the instruction
                    const tokenMints = await this.extractTokenMints(ix, accounts, transaction);
                    
                    if (tokenMints && tokenMints.tokenA && tokenMints.tokenB) {
                        // Check if it's a SOL pair
                        const isSOLPair = tokenMints.tokenA === this.config.wsol || 
                                         tokenMints.tokenB === this.config.wsol;
                        
                        if (isSOLPair) {
                            const tokenMint = tokenMints.tokenA === this.config.wsol 
                                ? tokenMints.tokenB 
                                : tokenMints.tokenA;
                            
                            return {
                                address: tokenMint,
                                poolId: transaction.transaction.signatures[0],
                                createdAt: transaction.blockTime * 1000,
                                programId: programId,
                                signature: transaction.transaction.signatures[0]
                            };
                        }
                    }
                }
            }
        } catch (error) {
            logger.debug('Error extracting pool info:', error.message);
        }
        
        return null;
    }

    async extractTokenMints(instruction, accounts, transaction) {
        try {
            // Different extraction logic based on program type
            if (instruction.programId.toString() === this.config.raydiumV4) {
                // V4 pool structure
                if (accounts.length >= 18) {
                    return {
                        tokenA: accounts[8]?.pubkey?.toString(),
                        tokenB: accounts[9]?.pubkey?.toString()
                    };
                }
            } else if (instruction.programId.toString() === this.config.raydiumCPMM) {
                // CPMM pool structure
                if (accounts.length >= 10) {
                    return {
                        tokenA: accounts[4]?.pubkey?.toString(),
                        tokenB: accounts[5]?.pubkey?.toString()
                    };
                }
            }
            
            // Fallback: Look for mint accounts in inner instructions
            if (transaction.meta && transaction.meta.innerInstructions) {
                for (const inner of transaction.meta.innerInstructions) {
                    for (const ix of inner.instructions) {
                        if (ix.parsed && ix.parsed.type === 'initializeMint') {
                            // Found a mint initialization
                            return {
                                tokenA: ix.parsed.info.mint,
                                tokenB: this.config.wsol // Assume SOL pair
                            };
                        }
                    }
                }
            }
        } catch (error) {
            logger.debug('Error extracting token mints:', error.message);
        }
        
        return null;
    }

    async enrichTokenData(poolInfo) {
        try {
            // Get token metadata
            const tokenInfo = await this.getTokenInfo(poolInfo.address);
            
            if (!tokenInfo) {
                return null;
            }

            // Get pool liquidity data
            const liquidityData = await this.getPoolLiquidity(poolInfo.poolId);
            
            // Get price data
            const priceData = await this.getTokenPrice(poolInfo.address);

            const enriched = {
                address: poolInfo.address,
                symbol: tokenInfo.symbol || 'UNKNOWN',
                name: tokenInfo.name || 'Unknown Token',
                decimals: tokenInfo.decimals || 9,
                price: priceData?.price || 0,
                liquidity: liquidityData?.liquidity || 1000,
                volume24h: liquidityData?.volume24h || 0,
                poolAddress: poolInfo.poolId,
                createdAt: poolInfo.createdAt,
                programType: this.getProgramType(poolInfo.programId),
                verified: false, // Raydium pools need additional verification
                platform: 'raydium',
                isNew: (Date.now() - poolInfo.createdAt) < 60 * 60 * 1000 // Less than 1 hour old
            };

            return enriched;
        } catch (error) {
            logger.debug(`Failed to enrich Raydium token ${poolInfo.address}:`, error.message);
            return null;
        }
    }

    async getTokenInfo(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            
            if (mintInfo.value?.data?.parsed?.info) {
                const info = mintInfo.value.data.parsed.info;
                
                // Try to get metadata from token extensions or known registries
                let metadata = { symbol: 'NEW', name: 'New Token' };
                
                // You could add calls to Metaplex metadata here
                
                return {
                    symbol: metadata.symbol,
                    name: metadata.name,
                    decimals: info.decimals,
                    supply: info.supply
                };
            }
        } catch (error) {
            logger.debug('Error getting token info:', error.message);
        }
        
        return null;
    }

    async getPoolLiquidity(poolId) {
        try {
            // Try to get liquidity from Raydium API if available
            const response = await axios.get(
                `https://api.raydium.io/v2/ammV3/ammPool/${poolId}`,
                { timeout: 5000 }
            ).catch(() => null);

            if (response && response.data) {
                return {
                    liquidity: response.data.tvl || 1000,
                    volume24h: response.data.day.volume || 0
                };
            }

            // Fallback: estimate from transaction
            return {
                liquidity: 5000, // Default estimate
                volume24h: 0
            };
        } catch (error) {
            return { liquidity: 1000, volume24h: 0 };
        }
    }

    async getTokenPrice(tokenAddress) {
        try {
            // Try Jupiter price API
            const response = await axios.get(
                `https://price.jup.ag/v4/price?ids=${tokenAddress}`,
                { timeout: 5000 }
            );
            
            if (response.data && response.data.data && response.data.data[tokenAddress]) {
                return response.data.data[tokenAddress];
            }
        } catch (error) {
            logger.debug('Failed to get token price:', error.message);
        }
        
        return null;
    }

    getProgramType(programId) {
        switch(programId) {
            case this.config.raydiumV4:
                return 'AMM_V4';
            case this.config.raydiumCPMM:
                return 'CPMM';
            case this.config.raydiumCLMM:
                return 'CLMM';
            default:
                return 'UNKNOWN';
        }
    }

    setupWebSocketMonitoring() {
        // Subscribe to Raydium program logs for real-time updates
        const programIds = [
            new PublicKey(this.config.raydiumV4),
            new PublicKey(this.config.raydiumCPMM)
        ];

        programIds.forEach(programId => {
            this.connection.onLogs(
                programId,
                async (logs) => {
                    if (logs.err) return;
                    
                    // Check if this is a pool creation
                    const isPoolCreation = logs.logs.some(log => 
                        log.includes('InitializeInstruction') || 
                        log.includes('Initialize2') ||
                        log.includes('CreatePool')
                    );

                    if (isPoolCreation) {
                        logger.info('🆕 Real-time Raydium pool creation detected!');
                        
                        // Process the transaction
                        setTimeout(async () => {
                            try {
                                const tx = await this.connection.getParsedTransaction(
                                    logs.signature,
                                    { maxSupportedTransactionVersion: 0 }
                                );
                                
                                if (tx) {
                                    const poolInfo = await this.extractPoolInfo(tx, programId.toString());
                                    if (poolInfo) {
                                        const enrichedToken = await this.enrichTokenData(poolInfo);
                                        if (enrichedToken && enrichedToken.liquidity >= this.config.minLiquidity) {
                                            this.tokens.set(poolInfo.address, enrichedToken);
                                            this.processedPools.add(logs.signature);
                                            this.emit('token', enrichedToken);
                                        }
                                    }
                                }
                            } catch (error) {
                                logger.error('Error processing real-time pool:', error);
                            }
                        }, 2000); // Wait 2 seconds for transaction to be confirmed
                    }
                },
                'confirmed'
            );
        });
        
        logger.info('🔌 Raydium WebSocket monitoring active');
    }

    async stop() {
        this.isRunning = false;
        
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        
        // Note: WebSocket subscriptions will be closed when connection is terminated
        
        logger.info('Raydium scanner stopped');
    }
}

module.exports = RaydiumScanner;