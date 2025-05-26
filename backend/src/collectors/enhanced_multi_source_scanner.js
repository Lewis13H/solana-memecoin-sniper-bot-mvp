// backend/src/collectors/enhanced_multi_source_scanner.js
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class EnhancedMultiSourceScanner extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL
        );
        
        this.isScanning = false;
        this.scanInterval = 10000; // 10 seconds
        this.processedTokens = new Set();
        this.processedPools = new Set();
        
        // Raydium Program IDs
        this.RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        this.RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
        
        // Scanner instances
        this.scanners = {};
        
        // Priority configuration
        this.sourcePriority = {
            'raydium': 10,      // Highest priority - direct from source
            'pumpfun': 9,
            'moonshot': 8,
            'jupiter': 7,
            'dexscreener': 6,
            'birdeye': 5,
            'bitquery': 6       // Bitquery as fallback
        };
        
        // Rate limiting
        this.rateLimits = {
            'bitquery': { max: 60, window: 60000, current: 0, reset: Date.now() + 60000 },
            'jupiter': { max: 300, window: 60000, current: 0, reset: Date.now() + 60000 },
            'raydium': { max: 100, window: 60000, current: 0, reset: Date.now() + 60000 },
            'dexscreener': { max: 120, window: 60000, current: 0, reset: Date.now() + 60000 },
            'birdeye': { max: 100, window: 60000, current: 0, reset: Date.now() + 60000 }
        };
        
        this.setupScanners();
    }

    setupScanners() {
        this.scannerConfigs = {
            // Bitquery for Pump.fun and Moonshot
            bitquery: {
                enabled: !!process.env.BITQUERY_API_KEY,
                url: 'https://graphql.bitquery.io',
                scanInterval: 15000
            },
            // Jupiter for established tokens
            jupiter: {
                enabled: true,
                url: 'https://price.jup.ag/v4',
                scanInterval: 20000
            },
            // Raydium for new pools
            raydium: {
                enabled: true,
                scanInterval: 5000
            },
            // DexScreener as reliable backup
            dexscreener: {
                enabled: true,
                url: 'https://api.dexscreener.com/latest/dex/search',
                scanInterval: 15000
            },
            // Birdeye if API key available
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
        logger.info('🚀 Enhanced Multi-Source Token Scanner started');

        // Start individual scanners
        this.startSourceScanners();

        // Main aggregation loop
        this.scanTimer = setInterval(async () => {
            try {
                await this.aggregateAndProcessTokens();
            } catch (error) {
                logger.error('Scanner aggregation error:', error);
            }
        }, this.scanInterval);
    }

    startSourceScanners() {
        // Bitquery scanner for Pump.fun and Moonshot
        if (this.scannerConfigs.bitquery.enabled) {
            this.startBitqueryScanner();
        }

        // Jupiter scanner
        if (this.scannerConfigs.jupiter.enabled) {
            this.startJupiterScanner();
        }

        // Raydium direct monitoring
        if (this.scannerConfigs.raydium.enabled) {
            this.startRaydiumMonitoring();
        }

        // DexScreener scanner
        if (this.scannerConfigs.dexscreener.enabled) {
            this.startDexScreenerScanner();
        }

        // Birdeye scanner
        if (this.scannerConfigs.birdeye.enabled) {
            this.startBirdeyeScanner();
        }
    }

    async checkRateLimit(source) {
        const limit = this.rateLimits[source];
        if (!limit) return true;

        if (Date.now() > limit.reset) {
            limit.current = 0;
            limit.reset = Date.now() + limit.window;
        }

        if (limit.current >= limit.max) {
            logger.debug(`Rate limit reached for ${source}`);
            return false;
        }

        limit.current++;
        return true;
    }

    // Bitquery Scanner for Pump.fun and Moonshot
    async startBitqueryScanner() {
        const scanner = {
            name: 'bitquery',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.bitquery = scanner;

        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('bitquery')) return;

            try {
                // Fetch Pump.fun tokens
                const pumpfunTokens = await this.fetchBitqueryPumpFun();
                // Fetch Moonshot tokens
                const moonshotTokens = await this.fetchBitqueryMoonshot();
                
                const allTokens = [...pumpfunTokens, ...moonshotTokens];
                
                for (const token of allTokens) {
                    if (!this.processedTokens.has(token.address)) {
                        scanner.tokens.set(token.address, token);
                        this.emit('token', token);
                    }
                }

                scanner.lastFetch = Date.now();
                logger.info(`Bitquery: Found ${allTokens.length} tokens (${pumpfunTokens.length} Pump.fun, ${moonshotTokens.length} Moonshot)`);

            } catch (error) {
                logger.error('Bitquery scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.bitquery.scanInterval);
    }

    async fetchBitqueryPumpFun() {
        const query = `
        query PumpFunNewTokens {
            Solana {
                Instructions(
                    where: {
                        Program: {
                            Address: {equals: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
                        }
                        Instruction: {
                            Program: {
                                Method: {is: "create"}
                            }
                        }
                    }
                    orderBy: {descending: Block_Time}
                    limit: {count: 20}
                ) {
                    Instruction {
                        Accounts {
                            Address
                        }
                    }
                    Transaction {
                        Signature
                    }
                    Block {
                        Time
                    }
                }
            }
        }`;

        try {
            const response = await axios.post(
                this.scannerConfigs.bitquery.url,
                { query },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': process.env.BITQUERY_API_KEY
                    },
                    timeout: 10000
                }
            );

            const instructions = response.data?.data?.Solana?.Instructions || [];
            const tokens = [];

            for (const inst of instructions) {
                if (inst.Instruction?.Accounts?.length >= 1) {
                    const tokenAddress = inst.Instruction.Accounts[0].Address;
                    const createdAt = new Date(inst.Block.Time).getTime();
                    
                    // Get additional token info
                    const tokenInfo = await this.getTokenInfoFromChain(tokenAddress);
                    
                    tokens.push({
                        address: tokenAddress,
                        symbol: tokenInfo?.symbol || 'UNKNOWN',
                        name: tokenInfo?.name || 'Pump.fun Token',
                        createdAt: createdAt,
                        source: 'pumpfun',
                        priority: this.sourcePriority.pumpfun,
                        liquidity: 1000, // Will be updated
                        volume24h: 0,
                        priceChange24h: 0,
                        marketCap: 0
                    });
                }
            }

            return tokens;
        } catch (error) {
            logger.error('Bitquery Pump.fun fetch error:', error.message);
            return [];
        }
    }

    async fetchBitqueryMoonshot() {
        const query = `
        query MoonshotTokens {
            Solana {
                DEXTradeByTokens(
                    where: {
                        Trade: {
                            Dex: {
                                ProgramAddress: {equals: "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG"}
                            }
                        }
                    }
                    orderBy: {descendingByField: "usd"}
                    limit: {count: 20}
                ) {
                    Trade {
                        Currency {
                            Symbol
                            Name
                            MintAddress
                        }
                        Dex {
                            ProtocolName
                        }
                    }
                    usd: sum(of: Trade_Amount_in_USD)
                    count
                }
            }
        }`;

        try {
            const response = await axios.post(
                this.scannerConfigs.bitquery.url,
                { query },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': process.env.BITQUERY_API_KEY
                    },
                    timeout: 10000
                }
            );

            const trades = response.data?.data?.Solana?.DEXTradeByTokens || [];
            
            return trades.map(trade => ({
                address: trade.Trade.Currency.MintAddress,
                symbol: trade.Trade.Currency.Symbol || 'UNKNOWN',
                name: trade.Trade.Currency.Name || 'Moonshot Token',
                volume24h: parseFloat(trade.usd || 0),
                source: 'moonshot',
                priority: this.sourcePriority.moonshot,
                createdAt: Date.now(), // Would need additional query for exact time
                liquidity: 1000,
                priceChange24h: 0,
                marketCap: 0
            }));
        } catch (error) {
            logger.error('Bitquery Moonshot fetch error:', error.message);
            return [];
        }
    }

    // Jupiter Scanner
    async startJupiterScanner() {
        const scanner = {
            name: 'jupiter',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.jupiter = scanner;

        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('jupiter')) return;

            try {
                // Get trending/new tokens from Jupiter
                const [priceData, tokenList] = await Promise.all([
                    this.fetchJupiterPrices(),
                    this.fetchJupiterTokenList()
                ]);

                // Filter for new or trending tokens
                const tokens = this.processJupiterTokens(priceData, tokenList);
                
                for (const token of tokens) {
                    if (!this.processedTokens.has(token.address)) {
                        scanner.tokens.set(token.address, token);
                        this.emit('token', token);
                    }
                }

                scanner.lastFetch = Date.now();
                logger.info(`Jupiter: Found ${tokens.length} relevant tokens`);

            } catch (error) {
                logger.error('Jupiter scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.jupiter.scanInterval);
    }

    async fetchJupiterPrices() {
        try {
            const response = await axios.get(
                `${this.scannerConfigs.jupiter.url}/price-list`,
                { timeout: 10000 }
            );
            
            return response.data?.data || [];
        } catch (error) {
            logger.error('Jupiter price fetch error:', error.message);
            return [];
        }
    }

    async fetchJupiterTokenList() {
        try {
            const response = await axios.get(
                'https://token.jup.ag/all',
                { timeout: 10000 }
            );
            
            return response.data || [];
        } catch (error) {
            logger.error('Jupiter token list fetch error:', error.message);
            return [];
        }
    }

    processJupiterTokens(priceData, tokenList) {
        const priceMap = new Map(priceData.map(p => [p.id, p]));
        const tokens = [];

        for (const token of tokenList) {
            const price = priceMap.get(token.address);
            if (!price) continue;

            // Filter for tokens with significant volume or new listings
            const volume = parseFloat(price.volume24h || 0);
            if (volume < 1000) continue; // Min $1k volume

            tokens.push({
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                price: parseFloat(price.price || 0),
                volume24h: volume,
                liquidity: parseFloat(price.liquidity || 0),
                priceChange24h: parseFloat(price.priceChange24h || 0),
                marketCap: parseFloat(price.marketCap || 0),
                source: 'jupiter',
                priority: this.sourcePriority.jupiter,
                createdAt: Date.now() - (24 * 60 * 60 * 1000) // Estimate
            });
        }

        // Sort by volume and return top tokens
        return tokens.sort((a, b) => b.volume24h - a.volume24h).slice(0, 50);
    }

    // Raydium Pool Monitoring
    async startRaydiumMonitoring() {
        const scanner = {
            name: 'raydium',
            tokens: new Map(),
            lastFetch: null,
            isRunning: true
        };
        
        this.scanners.raydium = scanner;

        // Subscribe to Raydium logs for real-time pool creation
        this.monitorRaydiumLogs();

        // Also do periodic checks for recent pools
        const scan = async () => {
            if (!scanner.isRunning || !await this.checkRateLimit('raydium')) return;

            try {
                const recentPools = await this.fetchRecentRaydiumPools();
                
                for (const pool of recentPools) {
                    if (!this.processedTokens.has(pool.address)) {
                        scanner.tokens.set(pool.address, pool);
                        this.emit('token', pool);
                        
                        // High priority alert for brand new Raydium pools
                        if (Date.now() - pool.createdAt < 5 * 60 * 1000) {
                            this.emit('high-priority', pool);
                            logger.info(`🔥 New Raydium pool: ${pool.symbol} (${pool.address})`);
                        }
                    }
                }

                scanner.lastFetch = Date.now();

            } catch (error) {
                logger.error('Raydium scanner error:', error.message);
            }
        };

        await scan();
        scanner.interval = setInterval(scan, this.scannerConfigs.raydium.scanInterval);
    }

    monitorRaydiumLogs() {
        logger.info('🔌 Starting Raydium real-time monitoring');
        
        // Monitor Raydium V4 program logs
        this.connection.onLogs(
            this.RAYDIUM_V4,
            async (logs) => {
                if (logs.err) return;
                
                // Check if this is a pool initialization
                const isPoolCreation = logs.logs.some(log => 
                    log.includes('initialize') || 
                    log.includes('InitializeInstruction') ||
                    log.includes('init_pool')
                );

                if (isPoolCreation) {
                    logger.info('🆕 Raydium pool creation detected!');
                    
                    try {
                        const tx = await this.connection.getParsedTransaction(
                            logs.signature,
                            { maxSupportedTransactionVersion: 0 }
                        );
                        
                        const poolInfo = await this.parseRaydiumPoolCreation(tx);
                        if (poolInfo && !this.processedTokens.has(poolInfo.address)) {
                            this.scanners.raydium.tokens.set(poolInfo.address, poolInfo);
                            this.emit('token', poolInfo);
                            this.emit('high-priority', poolInfo);
                            this.processedTokens.add(poolInfo.address);
                        }
                    } catch (error) {
                        logger.error('Error processing Raydium pool:', error);
                    }
                }
            },
            'confirmed'
        );

        // Also monitor CPMM pools
        this.connection.onLogs(
            this.RAYDIUM_CPMM,
            async (logs) => {
                if (logs.err) return;
                
                const isPoolCreation = logs.logs.some(log => 
                    log.includes('CreatePool') || 
                    log.includes('create_pool')
                );

                if (isPoolCreation) {
                    logger.info('🆕 Raydium CPMM pool creation detected!');
                    // Process CPMM pool...
                }
            },
            'confirmed'
        );
    }

    async fetchRecentRaydiumPools() {
        try {
            // Get recent transactions for Raydium
            const signatures = await this.connection.getSignaturesForAddress(
                this.RAYDIUM_V4,
                { limit: 100 }
            );

            const recentPools = [];
            const checkedSigs = new Set();

            for (const sig of signatures.slice(0, 20)) {
                if (checkedSigs.has(sig.signature)) continue;
                checkedSigs.add(sig.signature);

                try {
                    const tx = await this.connection.getParsedTransaction(
                        sig.signature,
                        { maxSupportedTransactionVersion: 0 }
                    );

                    if (!tx || !tx.meta) continue;

                    const poolInfo = await this.parseRaydiumPoolCreation(tx);
                    if (poolInfo && !this.processedPools.has(poolInfo.poolId)) {
                        recentPools.push(poolInfo);
                        this.processedPools.add(poolInfo.poolId);
                    }
                } catch (error) {
                    // Continue with next transaction
                }
            }

            return recentPools;
        } catch (error) {
            logger.error('Error fetching Raydium pools:', error.message);
            return [];
        }
    }

    async parseRaydiumPoolCreation(transaction) {
        try {
            if (!transaction || !transaction.transaction) return null;

            const accounts = transaction.transaction.message.accountKeys;
            if (accounts.length < 10) return null;

            // Look for token mint addresses
            const WSOL = 'So11111111111111111111111111111111111111112';
            let tokenMint = null;
            let poolId = null;

            // Find the non-SOL token
            for (let i = 0; i < accounts.length; i++) {
                const account = accounts[i];
                const pubkey = account.pubkey?.toString() || account;
                
                if (pubkey !== WSOL && pubkey.length === 44) {
                    // Check if this might be a token mint
                    const accountInfo = await this.connection.getAccountInfo(new PublicKey(pubkey));
                    if (accountInfo && accountInfo.owner.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                        tokenMint = pubkey;
                        break;
                    }
                }
            }

            if (!tokenMint) return null;

            // Get token info
            const tokenInfo = await this.getTokenInfoFromChain(tokenMint);
            if (!tokenInfo) return null;

            return {
                address: tokenMint,
                symbol: tokenInfo.symbol || 'NEW',
                name: tokenInfo.name || 'New Raydium Token',
                poolId: transaction.transaction.signatures[0],
                liquidity: 5000, // Will be updated by price fetcher
                volume24h: 0,
                priceChange24h: 0,
                marketCap: 0,
                createdAt: Date.now(),
                source: 'raydium',
                priority: this.sourcePriority.raydium,
                isNew: true,
                metadata: {
                    poolProgram: 'Raydium V4',
                    signature: transaction.transaction.signatures[0]
                }
            };
        } catch (error) {
            logger.error('Error parsing Raydium pool:', error);
            return null;
        }
    }

    // DexScreener Scanner (keep existing)
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

    // Birdeye Scanner (if API key available)
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
        if (age > 24 * 60 * 60 * 1000) return null;

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

    // Helper method to get token info from chain
    async getTokenInfoFromChain(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            
            if (mintInfo.value?.data?.parsed?.type === 'mint') {
                // Try to get metadata
                const [metadataPDA] = await PublicKey.findProgramAddress(
                    [
                        Buffer.from('metadata'),
                        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
                        mintPubkey.toBuffer()
                    ],
                    new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
                );

                const metadataAccount = await this.connection.getAccountInfo(metadataPDA);
                
                // Parse metadata if available
                let symbol = 'NEW';
                let name = 'New Token';
                
                if (metadataAccount) {
                    // Basic metadata parsing (simplified)
                    try {
                        const data = metadataAccount.data;
                        // This is simplified - real parsing would be more complex
                        const decoder = new TextDecoder();
                        const text = decoder.decode(data);
                        // Extract symbol and name from metadata
                        // This is a placeholder - real implementation would properly parse the metadata
                    } catch (e) {
                        // Use defaults
                    }
                }

                return {
                    symbol,
                    name,
                    decimals: mintInfo.value.data.parsed.info.decimals,
                    supply: mintInfo.value.data.parsed.info.supply
                };
            }
            
            return null;
        } catch (error) {
            logger.debug(`Error getting token info for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Aggregate and process tokens
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
            if (a.priority !== b.priority) {
                return b.priority - a.priority;
            }
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
            // Source-based scoring bonuses
            const sourceBonus = {
                'raydium': 25,      // Highest bonus for direct Raydium pools
                'pumpfun': 20,
                'moonshot': 15,
                'jupiter': 10,
                'dexscreener': 5,
                'birdeye': 5,
                'bitquery': 5
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
            const scoreThreshold = ['raydium', 'pumpfun', 'moonshot'].includes(token.source) ? 20 : 30;
            
            if (overallScore > scoreThreshold && riskScore < 85) {
                await this.db.addToken({
                    address: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    marketCap: token.marketCap,
                    liquidity: token.liquidity,
                    holders: token.holders || 0,
                    socialScore: ['raydium', 'pumpfun'].includes(token.source) ? 15 : 0,
                    riskScore: riskScore,
                    metadata: {
                        source: token.source,
                        ...token.metadata
                    }
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
        if (['raydium', 'jupiter'].includes(token.source)) risk -= 10;
        if (['pumpfun', 'moonshot'].includes(token.source)) risk -= 5;
        
        const avgScore = (analysis.liquidityScore + analysis.momentumScore + 
                         analysis.ageScore + analysis.volumeScore) / 4;
        if (avgScore < 40) risk += 15;
        
        return Math.min(100, Math.max(0, risk));
    }

    // Status and monitoring methods
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

    getScannerHealth() {
        const health = {};
        
        for (const [name, scanner] of Object.entries(this.scanners)) {
            const lastFetchAge = scanner.lastFetch ? Date.now() - scanner.lastFetch : null;
            health[name] = {
                running: scanner.isRunning,
                tokensFound: scanner.tokens?.size || 0,
                lastSuccessful: scanner.lastFetch ? new Date(scanner.lastFetch).toISOString() : 'Never',
                ageSeconds: lastFetchAge ? Math.floor(lastFetchAge / 1000) : null,
                healthy: lastFetchAge && lastFetchAge < 60000
            };
        }
        
        return health;
    }

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
        
        logger.info('Enhanced multi-source scanner stopped');
    }
}

module.exports = EnhancedMultiSourceScanner;