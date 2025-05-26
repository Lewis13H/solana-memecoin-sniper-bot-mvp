const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const logger = require('../utils/logger');

class TradingEngine {
    constructor(database) {
        this.db = database;
        this.connection = new Connection(
            process.env.HELIUS_API_KEY 
                ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
                : process.env.SOLANA_RPC_URL
        );
        
        // Paper trading mode
        this.paperTrading = process.env.PAPER_TRADING === 'true';
        this.paperBalance = parseFloat(process.env.PAPER_BALANCE || '10.0');
        this.paperPositions = new Map();
        
        // Real wallet (only for live trading)
        if (!this.paperTrading && process.env.PRIVATE_KEY) {
            try {
                this.wallet = Keypair.fromSecretKey(
                    bs58.decode(process.env.PRIVATE_KEY)
                );
                logger.info(`Trading wallet: ${this.wallet.publicKey.toBase58()}`);
            } catch (error) {
                logger.error('Invalid private key:', error);
                this.paperTrading = true; // Force paper trading on error
            }
        }
        
        // Configuration
        this.config = {
            maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.1'),
            maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '0.05'),
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || '5000'),
            maxPositions: 10,
            slippage: 3 // 3% slippage tolerance
        };
        
        this.isTrading = false;
        this.checkInterval = 15000; // 15 seconds
    }

    async startTrading() {
        if (this.isTrading) return;
        
        this.isTrading = true;
        logger.info(`💰 Trading engine started (${this.paperTrading ? 'PAPER' : 'LIVE'} mode)`);
        
        if (this.paperTrading) {
            logger.info(`Paper trading balance: ${this.paperBalance} SOL`);
        }

        // Initial check
        await this.checkTradingOpportunities();

        // Continuous monitoring
        this.tradingTimer = setInterval(async () => {
            try {
                await this.checkTradingOpportunities();
                await this.monitorPositions();
            } catch (error) {
                logger.error('Trading cycle error:', error);
            }
        }, this.checkInterval);
    }

    async checkTradingOpportunities() {
        try {
            // Check daily loss limit
            const dailyPnL = this.db.getDailyPnL();
            const accountBalance = await this.getAccountBalance();
            
            if (Math.abs(dailyPnL) / accountBalance > this.config.maxDailyLoss) {
                logger.warn('Daily loss limit reached, halting new trades');
                return;
            }

            // Get top opportunities
            const opportunities = this.db.getViableTokens(10);
            
            for (const token of opportunities) {
                // Skip if already have position
                if (this.hasPosition(token.address)) continue;
                
                // Analyze opportunity
                const analysis = await this.analyzeOpportunity(token);
                
                if (analysis.shouldTrade) {
                    await this.executeTrade(token, analysis);
                }
            }
        } catch (error) {
            logger.error('Error checking opportunities:', error);
        }
    }

    async analyzeOpportunity(token) {
        // Multi-factor analysis
        const factors = {
            socialScore: token.social_score > 15,
            riskAcceptable: token.risk_score < 60,
            liquidityOk: token.liquidity >= this.config.minLiquidity,
            momentumPositive: await this.checkMomentum(token),
            notOverExposed: this.getActivePositionCount() < this.config.maxPositions
        };
        
        const passedFactors = Object.values(factors).filter(Boolean).length;
        const confidence = (passedFactors / Object.keys(factors).length) * 100;
        
        return {
            shouldTrade: passedFactors >= 4,
            confidence: confidence,
            factors: factors,
            suggestedSize: this.calculatePositionSize(confidence)
        };
    }

    async checkMomentum(token) {
        try {
            // Get recent price data
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${token.address}`,
                { timeout: 5000 }
            );
            
            const pair = response.data?.pairs?.[0];
            if (!pair) return false;
            
            // Positive momentum = price up in last hour
            return pair.priceChange?.h1 > 5;
        } catch (error) {
            return false;
        }
    }

    calculatePositionSize(confidence) {
        // Dynamic position sizing based on confidence
        const baseSize = this.config.maxPositionSize;
        const confidenceMultiplier = confidence / 100;
        
        // Scale from 50% to 100% of max position size
        return baseSize * (0.5 + 0.5 * confidenceMultiplier);
    }

    async executeTrade(token, analysis) {
        const positionSize = analysis.suggestedSize;
        
        logger.info(`🎯 Executing ${this.paperTrading ? 'PAPER' : 'LIVE'} trade:`, {
            token: token.symbol,
            confidence: analysis.confidence.toFixed(1),
            size: positionSize.toFixed(3)
        });

        if (this.paperTrading) {
            await this.executePaperTrade(token, positionSize, 'buy');
        } else {
            await this.executeLiveTrade(token, positionSize, 'buy');
        }
    }

    async executePaperTrade(token, size, side) {
        try {
            // Simulate getting current price
            const currentPrice = await this.getCurrentPrice(token.address);
            if (!currentPrice) {
                logger.warn(`Could not get price for ${token.symbol}`);
                return;
            }

            const tokenAmount = size / currentPrice;
            const signature = `PAPER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            if (side === 'buy') {
                // Check paper balance
                if (this.paperBalance < size) {
                    logger.warn('Insufficient paper balance');
                    return;
                }

                // Record the trade
                this.db.recordTrade({
                    tokenAddress: token.address,
                    side: 'buy',
                    amount: tokenAmount,
                    price: currentPrice,
                    solAmount: size,
                    signature: signature,
                    status: 'completed'
                });

                // Update paper balance and positions
                this.paperBalance -= size;
                this.paperPositions.set(token.address, {
                    symbol: token.symbol,
                    amount: tokenAmount,
                    entryPrice: currentPrice,
                    entrySize: size,
                    entryTime: Date.now()
                });

                logger.info(`✅ Paper BUY executed: ${tokenAmount.toFixed(2)} ${token.symbol} for ${size} SOL`);
                
            } else if (side === 'sell') {
                const position = this.paperPositions.get(token.address);
                if (!position) return;

                const exitValue = position.amount * currentPrice;
                const pnl = exitValue - position.entrySize;
                const pnlPercent = (pnl / position.entrySize) * 100;

                // Record the trade
                this.db.recordTrade({
                    tokenAddress: token.address,
                    side: 'sell',
                    amount: position.amount,
                    price: currentPrice,
                    solAmount: exitValue,
                    signature: signature,
                    status: 'completed'
                });

                // Update paper balance
                this.paperBalance += exitValue;
                this.paperPositions.delete(token.address);

                // Update original buy trade with P&L
                this.db.updateTradeStatus(signature, 'completed', pnl);

                logger.info(`✅ Paper SELL executed: ${position.symbol} for ${exitValue.toFixed(3)} SOL (PnL: ${pnlPercent.toFixed(1)}%)`);
            }

        } catch (error) {
            logger.error('Paper trade execution error:', error);
        }
    }

    async executeLiveTrade(token, size, side) {
        // Placeholder for Jupiter integration
        logger.warn('Live trading not yet implemented - use paper trading mode');
        // In production, this would:
        // 1. Get optimal route from Jupiter
        // 2. Build transaction
        // 3. Sign and send transaction
        // 4. Monitor for confirmation
    }

    async monitorPositions() {
        try {
            // Paper trading positions
            if (this.paperTrading) {
                for (const [address, position] of this.paperPositions) {
                    await this.checkExitConditions(address, position);
                }
                return;
            }

            // Live positions would be monitored from portfolio table
            const positions = this.db.db.prepare(`
                SELECT * FROM portfolio WHERE balance > 0
            `).all();

            for (const position of positions) {
                await this.checkExitConditions(position.token_address, position);
            }
        } catch (error) {
            logger.error('Error monitoring positions:', error);
        }
    }

    async checkExitConditions(tokenAddress, position) {
        try {
            const currentPrice = await this.getCurrentPrice(tokenAddress);
            if (!currentPrice) return;

            const holdTime = Date.now() - position.entryTime;
            const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

            let shouldExit = false;
            let reason = '';

            // Take profit conditions
            if (pnlPercent >= 100) {
                shouldExit = true;
                reason = 'take_profit_100';
            } else if (pnlPercent >= 50 && holdTime > 30 * 60 * 1000) {
                shouldExit = true;
                reason = 'take_profit_50';
            }
            // Stop loss
            else if (pnlPercent <= -20) {
                shouldExit = true;
                reason = 'stop_loss';
            }
            // Time-based exit
            else if (holdTime > 24 * 60 * 60 * 1000 && pnlPercent < 10) {
                shouldExit = true;
                reason = 'time_exit_24h';
            }

            if (shouldExit) {
                logger.info(`📤 Exit signal for ${position.symbol}: ${reason} (${pnlPercent.toFixed(1)}%)`);
                
                if (this.paperTrading) {
                    await this.executePaperTrade(
                        { address: tokenAddress, symbol: position.symbol },
                        0, // Size not needed for sells
                        'sell'
                    );
                } else {
                    await this.executeLiveTrade(
                        { address: tokenAddress, symbol: position.symbol },
                        position.balance,
                        'sell'
                    );
                }
            }
        } catch (error) {
            logger.error(`Error checking exit conditions for ${tokenAddress}:`, error);
        }
    }

    async getCurrentPrice(tokenAddress) {
        try {
            const response = await axios.get(
                `https://price.jup.ag/v4/price?ids=${tokenAddress}`,
                { timeout: 5000 }
            );
            
            return response.data?.data?.[tokenAddress]?.price || null;
        } catch (error) {
            // Fallback to DexScreener
            try {
                const response = await axios.get(
                    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                    { timeout: 5000 }
                );
                return parseFloat(response.data?.pairs?.[0]?.priceUsd || 0);
            } catch (fallbackError) {
                return null;
            }
        }
    }

    async getAccountBalance() {
        if (this.paperTrading) {
            return this.paperBalance;
        }
        
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            return balance / 1e9; // Convert lamports to SOL
        } catch (error) {
            logger.error('Error getting account balance:', error);
            return 0;
        }
    }

    hasPosition(tokenAddress) {
        if (this.paperTrading) {
            return this.paperPositions.has(tokenAddress);
        }
        
        const position = this.db.db.prepare(
            'SELECT * FROM portfolio WHERE token_address = ? AND balance > 0'
        ).get(tokenAddress);
        
        return !!position;
    }

    getActivePositionCount() {
        if (this.paperTrading) {
            return this.paperPositions.size;
        }
        
        const result = this.db.db.prepare(
            'SELECT COUNT(*) as count FROM portfolio WHERE balance > 0'
        ).get();
        
        return result?.count || 0;
    }

    stopTrading() {
        this.isTrading = false;
        if (this.tradingTimer) {
            clearInterval(this.tradingTimer);
        }
        logger.info('Trading engine stopped');
    }
}

module.exports = TradingEngine;