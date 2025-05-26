// backend/src/collectors/scanners/moonshot_scanner.js
const ScannerBase = require('../scanner_base');
const axios = require('axios');

class MoonshotScanner extends ScannerBase {
    constructor(config) {
        super('moonshot', config);
        this.apiUrl = 'https://api.moonshot.cc/tokens/v1/solana';
        this.lastFetch = 0;
        this.fetchInterval = 30000; // 30 seconds
    }

    async fetchTokens() {
        try {
            // Check if we should fetch (rate limiting)
            const now = Date.now();
            if (now - this.lastFetch < this.fetchInterval) {
                return [];
            }
            
            this.lastFetch = now;

            const response = await axios.get(this.apiUrl, {
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'MoonshotBot/1.0'
                }
            });

            if (!response.data) {
                this.logger.warn('Moonshot API returned no data');
                return [];
            }

            // Handle different response formats
            let tokens = [];
            if (Array.isArray(response.data)) {
                tokens = response.data;
            } else if (response.data.tokens && Array.isArray(response.data.tokens)) {
                tokens = response.data.tokens;
            } else if (response.data.data && Array.isArray(response.data.data)) {
                tokens = response.data.data;
            } else {
                this.logger.warn('Unexpected Moonshot API response format');
                return [];
            }

            return tokens
                .filter(token => this.isValidToken(token))
                .map(token => this.parseToken(token))
                .slice(0, 50); // Limit to 50 tokens

        } catch (error) {
            // Don't log 404 or connection errors as errors
            if (error.response?.status === 404) {
                this.logger.debug('Moonshot API endpoint not found - service may be down');
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                this.logger.debug('Cannot connect to Moonshot API - service may be offline');
            } else {
                this.logger.debug(`Moonshot scanner error: ${error.message}`);
            }
            return [];
        }
    }

    isValidToken(token) {
        // Validate token has required fields
        return token && 
               (token.address || token.token_address || token.mint) &&
               (token.symbol || token.ticker) &&
               (token.marketCap || token.market_cap || token.fdv) > 0;
    }

    parseToken(token) {
        // Handle different field names that Moonshot might use
        const address = token.address || token.token_address || token.mint;
        const symbol = token.symbol || token.ticker || 'UNKNOWN';
        const name = token.name || token.token_name || symbol;
        const marketCap = token.marketCap || token.market_cap || token.fdv || 0;
        const price = token.price || token.price_usd || 0;
        const volume = token.volume || token.volume_24h || token.volume24h || 0;
        const liquidity = token.liquidity || token.liquidity_usd || marketCap * 0.1; // Estimate if not provided
        
        return {
            address: address,
            symbol: symbol.toUpperCase(),
            name: name,
            price: parseFloat(price),
            marketCap: parseFloat(marketCap),
            liquidity: parseFloat(liquidity),
            volume24h: parseFloat(volume),
            holders: token.holders || token.holder_count || 0,
            createdAt: token.created_at ? new Date(token.created_at).getTime() : Date.now(),
            source: 'moonshot',
            sourceUrl: `https://moonshot.cc/token/${address}`,
            metadata: {
                priceChange24h: token.price_change_24h || token.priceChange24h || 0,
                totalSupply: token.total_supply || token.totalSupply || 0
            }
        };
    }

    calculatePriority(token) {
        let priority = 50; // Base priority for Moonshot tokens

        // High market cap
        if (token.marketCap > 1000000) priority += 20;
        else if (token.marketCap > 100000) priority += 10;

        // High volume
        if (token.volume24h > 100000) priority += 20;
        else if (token.volume24h > 10000) priority += 10;

        // New tokens get priority
        const ageHours = (Date.now() - token.createdAt) / (1000 * 60 * 60);
        if (ageHours < 1) priority += 30;
        else if (ageHours < 6) priority += 20;
        else if (ageHours < 24) priority += 10;

        return Math.min(priority, 100);
    }
}

module.exports = MoonshotScanner;