// backend/src/collectors/scanners/moonshot_scanner.js
const EventEmitter = require('events');
const axios = require('axios');
const logger = require('../../utils/logger');

class MoonshotScanner extends EventEmitter {
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
            programId: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', // Moonshot program ID
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || 500),
            lookbackMinutes: 60 // Look for tokens created in last hour
        };
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🌙 Moonshot scanner started');
        
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
            query MoonshotTokens($programId: String!, $since: DateTime!) {
                Solana {
                    Instructions(
                        where: {
                            Instruction: {
                                Program: {
                                    Address: {is: $programId}
                                }
                            },
                            Transaction: {Success: true},
                            Block: {
                                Time: {since: $since}
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
                                Token {
                                    Mint
                                    Owner
                                }
                            }
                            Data
                            InternalSeqNumber
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
                const instructions = response.data.data.Solana.Instructions;
                await this.processInstructions(instructions);
            }

            this.lastUpdate = Date.now();
        } catch (error) {
            logger.error('Moonshot scanning error:', error.message);
            this.emit('error', error);
        }
    }

    async processInstructions(instructions) {
        for (const instruction of instructions) {
            try {
                // Look for token creation instructions
                const tokenData = await this.extractTokenData(instruction);
                
                if (tokenData && !this.tokens.has(tokenData.address)) {
                    // Get additional token info
                    const enrichedToken = await this.getTokenDetails(tokenData);
                    
                    if (enrichedToken && enrichedToken.liquidity >= this.config.minLiquidity) {
                        this.tokens.set(tokenData.address, enrichedToken);
                        this.emit('token', enrichedToken);
                        
                        logger.info(`🌙 New Moonshot token: ${enrichedToken.symbol} - ${enrichedToken.address}`);
                    }
                }
            } catch (error) {
                logger.debug('Error processing Moonshot instruction:', error.message);
            }
        }
    }

    async extractTokenData(instruction) {
        // Extract token mint from instruction accounts
        const accounts = instruction.Instruction.Accounts;
        
        // Look for mint accounts in the instruction
        for (const account of accounts) {
            if (account.Token && account.Token.Mint) {
                return {
                    address: account.Token.Mint,
                    createdAt: new Date(instruction.Block.Time).getTime(),
                    signature: instruction.Transaction.Signature,
                    creator: instruction.Transaction.FeePayer
                };
            }
        }
        
        // Alternative: Check first few accounts for mint pattern
        if (accounts && accounts.length >= 2) {
            const potentialMint = accounts[0].Address;
            
            // Validate if it looks like a mint address
            if (potentialMint && potentialMint.length === 44) {
                return {
                    address: potentialMint,
                    createdAt: new Date(instruction.Block.Time).getTime(),
                    signature: instruction.Transaction.Signature,
                    creator: instruction.Transaction.FeePayer
                };
            }
        }
        
        return null;
    }

    async getTokenDetails(tokenData) {
        try {
            // Query for token metadata and DEX data
            const query = `
            query TokenDetails($tokenAddress: String!, $since: DateTime!) {
                Solana {
                    TokenInfo: TokenSupply(
                        where: {Currency: {MintAddress: {is: $tokenAddress}}}
                    ) {
                        Currency {
                            Symbol
                            Name
                            MintAddress
                            Decimals
                        }
                        Supply: sum(of: Supply_Amount)
                    }
                    DEXTrades(
                        where: {
                            Trade: {
                                Buy: {
                                    Currency: {MintAddress: {is: $tokenAddress}}
                                }
                            }
                            Block: {
                                Time: {since: $since}
                            }
                        }
                    ) {
                        count
                        Trade {
                            Buy {
                                PriceInUSD
                                Amount
                                AmountInUSD
                            }
                        }
                    }
                    DEXPools: BalanceUpdates(
                        where: {
                            Currency: {MintAddress: {is: $tokenAddress}}
                        }
                        limit: {count: 1}
                    ) {
                        sum(of: BalanceUpdate_Amount)
                    }
                }
            }`;

            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            const response = await axios.post(
                this.bitqueryEndpoint,
                {
                    query,
                    variables: {
                        tokenAddress: tokenData.address,
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
                const solanaData = response.data.data.Solana;
                const tokenInfo = solanaData.TokenInfo[0];
                const trades = solanaData.DEXTrades;
                const poolBalance = solanaData.DEXPools[0];
                
                if (tokenInfo) {
                    // Calculate metrics
                    const totalVolume = trades.reduce((sum, t) => sum + (t.Trade.Buy.AmountInUSD || 0), 0);
                    const avgPrice = trades.length > 0 
                        ? trades.reduce((sum, t) => sum + (t.Trade.Buy.PriceInUSD || 0), 0) / trades.length
                        : 0;
                    
                    const enriched = {
                        ...tokenData,
                        symbol: tokenInfo.Currency.Symbol || 'UNKNOWN',
                        name: tokenInfo.Currency.Name || 'Unknown Token',
                        decimals: tokenInfo.Currency.Decimals,
                        totalSupply: tokenInfo.Supply,
                        price: avgPrice,
                        volume24h: totalVolume,
                        liquidity: Math.abs(poolBalance?.sum || 0) * avgPrice,
                        tradeCount: trades.length,
                        verified: true, // Moonshot tokens are verified
                        platform: 'moonshot'
                    };
                    
                    return enriched;
                }
            }
        } catch (error) {
            logger.debug(`Failed to get details for Moonshot token ${tokenData.address}:`, error.message);
        }
        
        return null;
    }

    async stop() {
        this.isRunning = false;
        
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
        }
        
        logger.info('Moonshot scanner stopped');
    }
}

module.exports = MoonshotScanner;