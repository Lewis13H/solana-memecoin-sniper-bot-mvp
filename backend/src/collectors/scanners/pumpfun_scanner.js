// backend/src/collectors/scanners/pumpfun_scanner.js
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const logger = require('../../utils/logger');
const EventEmitter = require('events');

class PumpFunScanner extends EventEmitter {
    constructor() {
        super();
        this.PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        this.connection = null;
        this.subscriptionId = null;
        this.isRunning = false;
        this.processedSignatures = new Set();
        this.recentTokens = new Map();
        
        // Stats
        this.stats = {
            tokensFound: 0,
            lastTokenTime: null,
            errors: 0
        };
    }

    async start(connection) {
        if (this.isRunning) return;
        
        this.connection = connection;
        this.isRunning = true;
        logger.info('🎯 Pump.fun scanner started');
        
        // Use Helius enhanced websockets if available
        if (process.env.HELIUS_API_KEY) {
            await this.startHeliusWebsocket();
        } else {
            await this.startStandardWebsocket();
        }
    }

    async startHeliusWebsocket() {
        try {
            const WebSocket = require('ws');
            const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
            
            ws.on('open', () => {
                logger.info('🔌 Connected to Helius enhanced websocket for Pump.fun monitoring');
                
                // Subscribe to pump.fun program logs
                const subscribeMessage = {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "logsSubscribe",
                    params: [{
                        mentions: [this.PUMP_FUN_PROGRAM_ID.toString()]
                    }, {
                        commitment: "confirmed"
                    }]
                };
                
                ws.send(JSON.stringify(subscribeMessage));
            });
            
            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    
                    if (message.params?.result?.value) {
                        await this.processLogEntry(message.params.result.value);
                    }
                } catch (error) {
                    logger.error('Error processing Helius websocket message:', error);
                }
            });
            
            ws.on('error', (error) => {
                logger.error('Helius websocket error:', error);
                this.stats.errors++;
            });
            
            ws.on('close', () => {
                logger.warn('Helius websocket closed, reconnecting...');
                if (this.isRunning) {
                    setTimeout(() => this.startHeliusWebsocket(), 5000);
                }
            });
            
            this.ws = ws;
        } catch (error) {
            logger.error('Failed to start Helius websocket:', error);
            // Fall back to standard websocket
            await this.startStandardWebsocket();
        }
    }

    async startStandardWebsocket() {
        try {
            // Subscribe to pump.fun program logs
            this.subscriptionId = this.connection.onLogs(
                this.PUMP_FUN_PROGRAM_ID,
                async (logs) => {
                    await this.processLogEntry(logs);
                },
                'confirmed'
            );
            
            logger.info('📡 Subscribed to Pump.fun program logs (standard websocket)');
        } catch (error) {
            logger.error('Failed to subscribe to pump.fun logs:', error);
            this.stats.errors++;
        }
    }

    async processLogEntry(logs) {
        try {
            // Check if this is a new token creation
            const signature = logs.signature;
            
            // Avoid processing the same transaction multiple times
            if (this.processedSignatures.has(signature)) {
                return;
            }
            this.processedSignatures.add(signature);
            
            // Keep set size manageable
            if (this.processedSignatures.size > 10000) {
                const toDelete = Array.from(this.processedSignatures).slice(0, 5000);
                toDelete.forEach(sig => this.processedSignatures.delete(sig));
            }
            
            // Look for token creation patterns in logs
            const isTokenCreation = logs.logs.some(log => 
                log.includes('initialize') || 
                log.includes('create') ||
                log.includes('Program log: Instruction: Create') ||
                log.includes('Token mint')
            );
            
            if (isTokenCreation) {
                logger.info('🆕 Potential Pump.fun token creation detected!');
                
                // Fetch and parse the transaction
                const tokenInfo = await this.parseTokenCreation(signature);
                if (tokenInfo) {
                    this.stats.tokensFound++;
                    this.stats.lastTokenTime = Date.now();
                    
                    // Emit the new token event
                    this.emit('token', tokenInfo);
                    
                    // Store recent token
                    this.recentTokens.set(tokenInfo.address, tokenInfo);
                    
                    // Clean up old tokens
                    if (this.recentTokens.size > 100) {
                        const oldest = Array.from(this.recentTokens.keys()).slice(0, 50);
                        oldest.forEach(key => this.recentTokens.delete(key));
                    }
                    
                    logger.info(`✅ New Pump.fun token: ${tokenInfo.symbol} (${tokenInfo.address})`);
                }
            }
        } catch (error) {
            logger.error('Error processing pump.fun log entry:', error);
            this.stats.errors++;
        }
    }

    async parseTokenCreation(signature) {
        try {
            const transaction = await this.connection.getParsedTransaction(
                signature,
                { maxSupportedTransactionVersion: 0 }
            );
            
            if (!transaction || !transaction.meta) return null;
            
            // Look for the token mint address in the transaction
            let tokenMint = null;
            let tokenInfo = {
                source: 'pumpfun',
                createdAt: Date.now(),
                signature: signature
            };
            
            // Check account keys for new mint
            const postTokenBalances = transaction.meta.postTokenBalances || [];
            const preTokenBalances = transaction.meta.preTokenBalances || [];
            
            // Find new token mints by comparing pre and post balances
            for (const postBalance of postTokenBalances) {
                const isNew = !preTokenBalances.some(
                    preBalance => preBalance.mint === postBalance.mint
                );
                
                if (isNew && postBalance.mint) {
                    tokenMint = postBalance.mint;
                    break;
                }
            }
            
            // Alternative: Look in inner instructions
            if (!tokenMint && transaction.meta.innerInstructions) {
                for (const inner of transaction.meta.innerInstructions) {
                    for (const ix of inner.instructions) {
                        if (ix.parsed?.type === 'initializeMint' || 
                            ix.parsed?.type === 'initializeAccount') {
                            tokenMint = ix.parsed.info?.mint || ix.parsed.info?.account;
                            break;
                        }
                    }
                }
            }
            
            if (!tokenMint) {
                // Try to extract from logs or use first new account
                const accounts = transaction.transaction.message.accountKeys;
                for (let i = 0; i < accounts.length; i++) {
                    const account = accounts[i];
                    if (account.pubkey && !account.signer && !account.writable) {
                        const accountInfo = await this.connection.getAccountInfo(
                            new PublicKey(account.pubkey.toString())
                        );
                        
                        if (accountInfo?.owner.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                            tokenMint = account.pubkey.toString();
                            break;
                        }
                    }
                }
            }
            
            if (!tokenMint) {
                logger.debug('Could not find token mint in pump.fun transaction');
                return null;
            }
            
            tokenInfo.address = tokenMint;
            
            // Try to get token metadata
            try {
                const metadata = await this.fetchTokenMetadata(tokenMint);
                tokenInfo = { ...tokenInfo, ...metadata };
            } catch (error) {
                logger.debug('Could not fetch metadata for pump.fun token:', tokenMint);
                // Use defaults
                tokenInfo.symbol = 'PUMP';
                tokenInfo.name = 'Pump.fun Token';
            }
            
            // Add pump.fun specific data
            tokenInfo.liquidity = 1000; // Initial liquidity assumption
            tokenInfo.volume24h = 0;
            tokenInfo.priceChange24h = 0;
            tokenInfo.marketCap = 0;
            tokenInfo.isPumpFun = true;
            tokenInfo.deploymentType = 'pump.fun';
            
            return tokenInfo;
            
        } catch (error) {
            logger.error('Error parsing pump.fun token creation:', error);
            return null;
        }
    }

    async fetchTokenMetadata(mintAddress) {
        // Try multiple sources for metadata
        
        // 1. Try Birdeye if available
        if (process.env.BIRDEYE_API_KEY) {
            try {
                const response = await axios.get(
                    `https://public-api.birdeye.so/defi/token_overview`,
                    {
                        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY },
                        params: { address: mintAddress },
                        timeout: 5000
                    }
                );
                
                if (response.data?.data) {
                    return {
                        symbol: response.data.data.symbol || 'PUMP',
                        name: response.data.data.name || 'Pump Token',
                        decimals: response.data.data.decimals || 9,
                        price: response.data.data.price || 0
                    };
                }
            } catch (error) {
                // Continue to next method
            }
        }
        
        // 2. Try Jupiter price API
        try {
            const response = await axios.get(
                `https://price.jup.ag/v4/price?ids=${mintAddress}`,
                { timeout: 3000 }
            );
            
            if (response.data?.data?.[mintAddress]) {
                const data = response.data.data[mintAddress];
                return {
                    symbol: data.mintSymbol || 'PUMP',
                    price: data.price || 0
                };
            }
        } catch (error) {
            // Continue to fallback
        }
        
        // 3. Fallback to on-chain data
        try {
            const mintInfo = await this.connection.getParsedAccountInfo(
                new PublicKey(mintAddress)
            );
            
            if (mintInfo.value?.data?.parsed?.info) {
                return {
                    decimals: mintInfo.value.data.parsed.info.decimals || 9,
                    symbol: 'PUMP',
                    name: 'Pump.fun Token'
                };
            }
        } catch (error) {
            // Use defaults
        }
        
        return {
            symbol: 'PUMP',
            name: 'Pump.fun Token',
            decimals: 9
        };
    }

    async getRecentTokens(limit = 10) {
        const tokens = Array.from(this.recentTokens.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
        
        return tokens;
    }

    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            recentTokensCount: this.recentTokens.size
        };
    }

    async stop() {
        this.isRunning = false;
        
        if (this.subscriptionId !== null) {
            await this.connection.removeOnLogsListener(this.subscriptionId);
            this.subscriptionId = null;
        }
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        logger.info('Pump.fun scanner stopped');
    }
}

module.exports = PumpFunScanner;