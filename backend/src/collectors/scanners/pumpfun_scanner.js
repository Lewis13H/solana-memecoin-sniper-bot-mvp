// backend/src/collectors/scanners/pumpfun_scanner.js
const EventEmitter = require('events');
const axios = require('axios');
const logger = require('../../utils/logger');

class PumpFunScanner extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.tokens = new Map();
        this.lastUpdate = null;
        this.scanInterval = 30000; // 30 seconds
        
        // Bitquery configuration
        this.bitqueryEndpoint = 'https://graphql.bitquery.io';
        this.bitqueryApiKey = process.env.BITQUERY_API_KEY;
        
        this.config = {
            enabled: true,
            programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun program ID
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || 500),
            lookbackMinutes: 60 // Look for tokens created in last hour
        };
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🎮 Pump.fun scanner started');
        
        // Initial scan
        await this.scanTokens();
        
        // Set up periodic scanning
        this.scanTimer = setInterval(() => {
            this.scanTokens();
        }, this.scanInterval);
    }

    async scanTokens() {
        try {
            const query = `
            query PumpFunTokens($programId: String!, $since: DateTime!) {
                Solana {
                    Events(
                        where: {
                            Transaction: {
                                Result: {Success: true}
                            },
                            Block: {
                                Time: {since: $since}
                            },
                            Instruction: {
                                Program: {
                                    Address: {is: $programId}
                                }
                            }
                        }
                        orderBy: {descending: Block_Time}
                        limit: {count: 100}
                    ) {
                        Transaction {
                            Signature
                            FeePayer
                        }
                        Block {
                            Time
                            Height
                        }
                        Instruction {
                            Accounts {
                                Address
                                IsWritable
                            }
                            Data
                            Program {
                                Address
                                Name
                            }
                        }
                    }
                }
            }`;

            const since = new Date(Date.now() - this.config.lookbackMinutes * 60 * 1000).toISOString();
            
            const response = await axios.post(
                this.bitqueryEndpoint,
                {
                    query,
                    variables: {
                        programId: this.config.programId,
                        since: since
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': this.bitqueryApiKey
                    }
                }
            );

            if (response.data && response.data.data && response.data.data.Solana) {
                const events = response.data.data.Solana.Events;
                await this.processEvents(events);
            }

            this.lastUpdate = Date.now();
        } catch (error) {
            logger.error('Pump.fun scanning error:', error.message);
            this.emit('error', error);
        }
    }

    async processEvents(events) {
        for (const event of events) {
            try {
                // Look for token creation events
                const tokenData = await this.extractTokenData(event);
                
                if (tokenData && !this.tokens.has(tokenData.address)) {
                    // Get additional token info
                    const enrichedToken = await this.getTokenDetails(tokenData);
                    
                    if (enrichedToken && enrichedToken.liquidity >= this.config.minLiquidity) {
                        this.tokens.set(tokenData.address, enrichedToken);
                        this.emit('token', enrichedToken);
                        
                        logger.info(`🎮 New Pump.fun token: ${enrichedToken.symbol} - ${enrichedToken.address}`);
                    }
                }
            } catch (error) {
                logger.debug('Error processing Pump.fun event:', error.message);
            }
        }
    }

    async extractTokenData(event) {
        // Extract token mint address from instruction accounts
        const accounts = event.Instruction.Accounts;
        
        // Pump.fun typically has the token mint at a specific index
        if (accounts && accounts.length >= 3) {
            const tokenMint = accounts[0].Address; // Adjust based on actual instruction structure
            
            return {
                address: tokenMint,
                createdAt: new Date(event.Block.Time).getTime(),
                signature: event.Transaction.Signature,
                creator: event.Transaction.FeePayer
            };
        }
        
        return null;
    }

    async getTokenDetails(tokenData) {
        try {
            // Query for token metadata and trading data
            const query = `
            query TokenDetails($tokenAddress: String!) {
                Solana {
                    TokenSupply(
                        where: {Currency: {MintAddress: {is: $tokenAddress}}}
                    ) {
                        Currency {
                            Symbol
                            Name
                            MintAddress
                            Decimals
                        }
                        amount: sum(of: Supply_Amount)
                    }
                    DEXTradeByTokens(
                        where: {
                            Trade: {
                                Currency: {MintAddress: {is: $tokenAddress}}
                            }
                        }
                        limit: {count: 1}
                    ) {
                        Trade {
                            PriceInUSD
                            AmountInUSD
                        }
                        Block {
                            Time
                        }
                    }
                }
            }`;

            const response = await axios.post(
                this.bitqueryEndpoint,
                {
                    query,
                    variables: {
                        tokenAddress: tokenData.address
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': this.bitqueryApiKey
                    }
                }
            );

            if (response.data && response.data.data && response.data.data.Solana) {
                const tokenSupply = response.data.data.Solana.TokenSupply[0];
                const trades = response.data.data.Solana.DEXTradeByTokens;
                
                if (tokenSupply) {
                    const enriched = {
                        ...tokenData,
                        symbol: tokenSupply.Currency.Symbol || 'UNKNOWN',
                        name: tokenSupply.Currency.Name || 'Unknown Token',
                        decimals: tokenSupply.Currency.Decimals,
                        totalSupply: tokenSupply.amount,
                        price: trades.length > 0 ? trades[0].Trade.PriceInUSD : 0,
                        volume24h: trades.length > 0 ? trades[0].Trade.AmountInUSD : 0,
                        liquidity: await this.estimateLiquidity(tokenData.address),
                        verified: true, // Pump.fun tokens are pre-verified
                        platform: 'pump.fun'
                    };
                    
                    return enriched;
                }
            }
        } catch (error) {
            logger.debug(`Failed to get details for token ${tokenData.address}:`, error.message);
        }
        
        return null;
    }

    async estimateLiquidity(tokenAddress) {
        try {
            // Query recent liquidity data
            const query = `
            query TokenLiquidity($tokenAddress: String!) {
                Solana {
                    BalanceUpdates(
                        where: {
                            Currency: {MintAddress: {is: $tokenAddress}}
                        }
                        orderBy: {descending: Block_Time}
                        limit: {count: 10}
                    ) {
                        sum(of: BalanceUpdate_Amount)
                        Currency {
                            MintAddress
                        }
                    }
                }
            }`;

            const response = await axios.post(
                this.bitqueryEndpoint,
                {
                    query,
                    variables: { tokenAddress }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': this.bitqueryApiKey
                    }
                }
            );

            if (response.data && response.data.data && response.data.data.Solana) {
                const balance = response.data.data.Solana.BalanceUpdates;
                // Estimate liquidity based on balance changes
                return Math.abs(balance) * 0.1; // Simplified estimation
            }
        } catch (error) {
            logger.debug('Failed to estimate liquidity:', error.message);
        }
        
        return 1000; // Default minimum liquidity
    }

    async stop() {
        this.isRunning = false;
        
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        
        logger.info('Pump.fun scanner stopped');
    }
}

module.exports = PumpFunScanner;