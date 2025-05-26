// backend/src/collectors/scanners/pumpfun_scanner.js
const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class PumpFunScanner extends EventEmitter {
    constructor(config) {
        super();
        this.config = config.sources.pumpfun;
        this.tokens = new Map();
        this.lastFetch = 0;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🎯 Starting Pump.fun scanner');
        
        // Start WebSocket connection for real-time updates
        this.connectWebSocket();
        
        // Initial fetch
        await this.fetchRecentTokens();
        
        // Periodic fetch as backup
        this.fetchInterval = setInterval(() => {
            this.fetchRecentTokens();
        }, 30000); // Every 30 seconds
    }

    connectWebSocket() {
        try {
            // Pump.fun uses Socket.IO, so we need to handle the connection properly
            const io = require('socket.io-client');
            
            this.socket = io('https://client-api-2-74b1891ee9f9.herokuapp.com', {
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 5000,
                reconnectionAttempts: 10
            });

            this.socket.on('connect', () => {
                logger.info('✅ Connected to Pump.fun WebSocket');
                this.reconnectAttempts = 0;
                
                // Subscribe to new token events
                this.socket.emit('subscribe', {
                    type: 'new_coins',
                    channel: 'global'
                });
            });

            this.socket.on('newCoin', (data) => {
                this.handleNewToken(data);
            });

            this.socket.on('tradeCreated', (data) => {
                this.handleTrade(data);
            });

            this.socket.on('disconnect', (reason) => {
                logger.warn(`Pump.fun WebSocket disconnected: ${reason}`);
            });

            this.socket.on('error', (error) => {
                logger.error('Pump.fun WebSocket error:', error);
            });

        } catch (error) {
            logger.error('Failed to connect to Pump.fun WebSocket:', error);
            // Fallback to polling only
        }
    }

    async fetchRecentTokens() {
        try {
            const response = await axios.get(
                `${this.config.api.base}${this.config.api.endpoints.recent}`,
                {
                    timeout: 10000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );

            if (response.data && Array.isArray(response.data)) {
                const tokens = response.data
                    .filter(token => this.isValidToken(token))
                    .map(token => this.formatToken(token));

                for (const token of tokens) {
                    if (!this.tokens.has(token.address)) {
                        this.tokens.set(token.address, token);
                        this.emit('token', token);
                    }
                }

                logger.info(`📊 Pump.fun: Fetched ${tokens.length} tokens`);
            }

        } catch (error) {
            logger.error('Pump.fun API error:', error.message);
        }
    }

    async fetchTokenDetails(mintAddress) {
        try {
            const response = await axios.get(
                `${this.config.api.base}${this.config.api.endpoints.token}${mintAddress}`,
                {
                    timeout: 5000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );

            return this.formatToken(response.data);
        } catch (error) {
            logger.error(`Failed to fetch Pump.fun token details for ${mintAddress}:`, error.message);
            return null;
        }
    }

    handleNewToken(data) {
        try {
            const token = this.formatToken(data);
            
            if (this.isValidToken(data) && !this.tokens.has(token.address)) {
                this.tokens.set(token.address, token);
                
                logger.info(`🆕 Pump.fun: New token ${token.symbol} detected in real-time!`);
                
                // Emit immediately for high priority processing
                this.emit('token', { ...token, priority: 100 });
            }
        } catch (error) {
            logger.error('Error handling new Pump.fun token:', error);
        }
    }

    handleTrade(data) {
        // Update token metrics based on trades
        if (data.mint && this.tokens.has(data.mint)) {
            const token = this.tokens.get(data.mint);
            
            // Update volume and price data
            if (data.sol_amount) {
                token.volume24h = (token.volume24h || 0) + parseFloat(data.sol_amount);
            }
            
            if (data.token_amount && data.sol_amount) {
                const price = parseFloat(data.sol_amount) / parseFloat(data.token_amount);
                token.lastPrice = price;
                token.lastUpdate = Date.now();
            }
        }
    }

    formatToken(pumpToken) {
        // Calculate actual price from market cap and supply
        const virtualSolReserves = parseFloat(pumpToken.virtual_sol_reserves || 0);
        const virtualTokenReserves = parseFloat(pumpToken.virtual_token_reserves || 1);
        const price = virtualSolReserves / virtualTokenReserves;
        
        // Calculate market cap
        const totalSupply = parseFloat(pumpToken.total_supply || 1000000000);
        const marketCap = price * totalSupply;
        
        return {
            address: pumpToken.mint,
            symbol: pumpToken.symbol || 'UNKNOWN',
            name: pumpToken.name || pumpToken.symbol,
            price: price,
            priceUsd: price * this.getSolPrice(), // You'd need to fetch SOL price
            liquidity: virtualSolReserves * this.getSolPrice(),
            liquiditySol: virtualSolReserves,
            volume24h: parseFloat(pumpToken.volume || 0),
            marketCap: marketCap * this.getSolPrice(),
            holders: parseInt(pumpToken.holder_count || 0),
            createdAt: pumpToken.created_timestamp || Date.now(),
            
            // Pump.fun specific data
            bondingCurveProgress: parseFloat(pumpToken.bonding_curve || 0),
            totalSupply: totalSupply,
            virtualReserves: {
                sol: virtualSolReserves,
                token: virtualTokenReserves
            },
            
            // Social links
            metadata: {
                twitter: pumpToken.twitter,
                telegram: pumpToken.telegram,
                website: pumpToken.website,
                description: pumpToken.description,
                imageUri: pumpToken.image_uri || pumpToken.metadata_uri
            },
            
            // Trading metrics
            txCount: parseInt(pumpToken.reply_count || 0),
            kingOfTheHillMinutes: parseInt(pumpToken.king_of_the_hill_minutes || 0),
            
            // Source metadata
            source: 'pumpfun',
            sourceData: {
                curveComplete: pumpToken.complete || false,
                migrated: pumpToken.raydium_pool ? true : false,
                raydiumPool: pumpToken.raydium_pool
            }
        };
    }

    isValidToken(token) {
        // Filter out invalid or completed bonding curves
        if (!token || !token.mint) return false;
        
        // Skip if bonding curve is complete (already migrated to Raydium)
        if (token.complete === true) return false;
        
        // Skip if no liquidity
        const solReserves = parseFloat(token.virtual_sol_reserves || 0);
        if (solReserves < 0.1) return false; // Less than 0.1 SOL
        
        // Skip very old tokens
        const age = Date.now() - (token.created_timestamp || 0);
        if (age > 24 * 60 * 60 * 1000) return false; // Older than 24 hours
        
        return true;
    }

    getSolPrice() {
        // In production, fetch this from a price feed
        return 150; // Placeholder
    }

    async getTopMovers(limit = 10) {
        // Get tokens with highest momentum
        const tokens = Array.from(this.tokens.values())
            .filter(t => t.volume24h > 0)
            .sort((a, b) => {
                // Sort by a combination of volume and age (newer + higher volume = better)
                const ageA = Date.now() - a.createdAt;
                const ageB = Date.now() - b.createdAt;
                const scoreA = a.volume24h / (ageA / 3600000 + 1); // Volume per hour
                const scoreB = b.volume24h / (ageB / 3600000 + 1);
                return scoreB - scoreA;
            })
            .slice(0, limit);

        return tokens;
    }

    stop() {
        this.isRunning = false;
        
        if (this.socket) {
            this.socket.disconnect();
        }
        
        if (this.fetchInterval) {
            clearInterval(this.fetchInterval);
        }
        
        logger.info('Pump.fun scanner stopped');
    }
}

module.exports = PumpFunScanner;