// backend/src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const DatabaseManager = require('./utils/database');
const MultiSourceTokenScanner = require('./collectors/multi_source_token_scanner');
const SocialMonitor = require('./collectors/social_monitor');
const InfluencerTracker = require('./collectors/influencer_tracker');
const TradingEngine = require('./executors/trading_engine');
const logger = require('./utils/logger');

class MemecoinTradingBot {
    constructor() {
        this.app = express();
        this.db = new DatabaseManager();
        
        // Initialize trading engine first
        this.tradingEngine = new TradingEngine(this.db);
        
        // Initialize components with MultiSourceTokenScanner
        this.components = {
            scanner: new MultiSourceTokenScanner(this.db),
            social: new SocialMonitor(this.db),
            influencer: new InfluencerTracker(this.db, this.tradingEngine),
            trading: this.tradingEngine
        };
        
        this.isRunning = false;
        this.setupExpress();
        this.setupRoutes();
    }

    setupExpress() {
        this.app.use(helmet());
        this.app.use(cors());
        this.app.use(express.json());
        
        // Serve static files from frontend
        if (process.env.NODE_ENV === 'production') {
            this.app.use(express.static(path.join(__dirname, '../../frontend/build')));
        }
    }

    setupRoutes() {
        // System status
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: this.isRunning ? 'running' : 'stopped',
                mode: process.env.PAPER_TRADING === 'true' ? 'paper' : 'live',
                timestamp: new Date().toISOString(),
                components: {
                    scanner: this.components.scanner.isScanning,
                    social: this.components.social.isMonitoring,
                    influencer: this.components.influencer.isTracking,
                    trading: this.components.trading.isTrading
                },
                features: {
                    multiSourceScanning: true,
                    raydiumMonitoring: !!process.env.HELIUS_API_KEY,
                    twitterTracking: !!process.env.TWITTER_BEARER_TOKEN,
                    birdeyeIntegration: !!process.env.BIRDEYE_API_KEY
                },
                version: '2.1.0'
            });
        });

        // Scanner status endpoint
        this.app.get('/api/scanners/status', (req, res) => {
            const scannerStatus = {};
            
            if (this.components.scanner.scanners) {
                for (const [name, scanner] of this.components.scanner.scanners) {
                    scannerStatus[name] = {
                        enabled: true,
                        running: scanner.isRunning || false,
                        tokensFound: scanner.tokens?.size || 0,
                        lastUpdate: scanner.lastFetch || null
                    };
                }
            }
            
            res.json(scannerStatus);
        });

        // Get top movers across all sources
        this.app.get('/api/tokens/movers', async (req, res) => {
            try {
                const movers = await this.components.scanner.getTopMovers(20);
                res.json(movers);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get discovered tokens
        this.app.get('/api/tokens', (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const tokens = this.db.getViableTokens(limit);
                res.json(tokens);
            } catch (error) {
                logger.error('Error fetching tokens:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get recent trades
        this.app.get('/api/trades', (req, res) => {
            try {
                const stmt = this.db.db.prepare(`
                    SELECT t.*, tk.symbol, tk.name 
                    FROM trades t
                    LEFT JOIN tokens tk ON t.token_address = tk.address
                    ORDER BY t.created_at DESC 
                    LIMIT ?
                `);
                const trades = stmt.all(parseInt(req.query.limit) || 50);
                res.json(trades);
            } catch (error) {
                logger.error('Error fetching trades:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get portfolio
        this.app.get('/api/portfolio', (req, res) => {
            try {
                if (process.env.PAPER_TRADING === 'true') {
                    const positions = Array.from(this.components.trading.paperPositions.entries()).map(
                        ([address, position]) => ({
                            token_address: address,
                            symbol: position.symbol,
                            balance: position.amount,
                            avg_buy_price: position.entryPrice,
                            total_invested: position.entrySize,
                            current_value: position.amount * position.entryPrice,
                            pnl: 0
                        })
                    );
                    
                    res.json({
                        positions: positions,
                        summary: {
                            total_positions: positions.length,
                            paper_balance: this.components.trading.paperBalance,
                            total_value: positions.reduce((sum, p) => sum + p.current_value, 0)
                        }
                    });
                } else {
                    const positions = this.db.db.prepare(`
                        SELECT p.*, t.symbol, t.name 
                        FROM portfolio p
                        LEFT JOIN tokens t ON p.token_address = t.address
                        WHERE p.balance > 0
                    `).all();
                    
                    res.json({
                        positions: positions,
                        summary: {
                            total_positions: positions.length,
                            total_invested: positions.reduce((sum, p) => sum + p.total_invested, 0)
                        }
                    });
                }
            } catch (error) {
                logger.error('Error fetching portfolio:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get performance metrics
        this.app.get('/api/performance', (req, res) => {
            try {
                const days = parseInt(req.query.days) || 30;
                const stmt = this.db.db.prepare(`
                    SELECT 
                        DATE(executed_at) as date,
                        COUNT(*) as total_trades,
                        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                        SUM(profit_loss) as daily_pnl,
                        AVG(profit_loss) as avg_pnl
                    FROM trades
                    WHERE executed_at IS NOT NULL
                    AND DATE(executed_at) >= DATE('now', '-' || ? || ' days')
                    GROUP BY DATE(executed_at)
                    ORDER BY date DESC
                `);
                
                const dailyStats = stmt.all(days);
                
                const totalTrades = dailyStats.reduce((sum, d) => sum + d.total_trades, 0);
                const totalWins = dailyStats.reduce((sum, d) => sum + d.winning_trades, 0);
                const totalPnL = dailyStats.reduce((sum, d) => sum + d.daily_pnl, 0);
                
                res.json({
                    daily: dailyStats,
                    summary: {
                        total_trades: totalTrades,
                        win_rate: totalTrades > 0 ? (totalWins / totalTrades) : 0,
                        total_pnl: totalPnL,
                        avg_daily_pnl: totalPnL / Math.max(dailyStats.length, 1)
                    }
                });
            } catch (error) {
                logger.error('Error fetching performance:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get influencer activity
        this.app.get('/api/influencers', (req, res) => {
            try {
                // Get recent influencer calls
                const stmt = this.db.db.prepare(`
                    SELECT * FROM influencer_calls
                    ORDER BY timestamp DESC
                    LIMIT 20
                `);
                
                const calls = stmt.all().map(call => ({
                    ...call,
                    tokens: JSON.parse(call.tokens || '[]')
                }));
                
                res.json({
                    recent_calls: calls,
                    tracked_influencers: Array.from(this.components.influencer.influencers.entries()).map(
                        ([handle, info]) => ({ handle, ...info })
                    )
                });
            } catch (error) {
                // Table might not exist yet
                res.json({ recent_calls: [], tracked_influencers: [] });
            }
        });

        // Control endpoints
        this.app.post('/api/start', async (req, res) => {
            try {
                await this.start();
                res.json({ message: 'Bot started successfully' });
            } catch (error) {
                logger.error('Error starting bot:', error);
                res.status(500).json({ error: 'Failed to start bot' });
            }
        });

        this.app.post('/api/stop', (req, res) => {
            try {
                this.stop();
                res.json({ message: 'Bot stopped successfully' });
            } catch (error) {
                logger.error('Error stopping bot:', error);
                res.status(500).json({ error: 'Failed to stop bot' });
            }
        });

        // Emergency stop
        this.app.post('/api/emergency-stop', (req, res) => {
            logger.warn('EMERGENCY STOP ACTIVATED');
            this.stop();
            res.json({ message: 'Emergency stop activated' });
        });

        // Feature toggles
        this.app.post('/api/features/toggle', (req, res) => {
            const { feature, enabled } = req.body;
            
            switch(feature) {
                case 'influencer':
                    if (enabled) {
                        this.components.influencer.startTracking();
                    } else {
                        this.components.influencer.stopTracking();
                    }
                    break;
                case 'social':
                    if (enabled) {
                        this.components.social.startMonitoring();
                    } else {
                        this.components.social.stopMonitoring();
                    }
                    break;
            }
            
            res.json({ message: `Feature ${feature} ${enabled ? 'enabled' : 'disabled'}` });
        });

        // Serve React app for all other routes in production
        if (process.env.NODE_ENV === 'production') {
            this.app.get('*', (req, res) => {
                res.sendFile(path.join(__dirname, '../../frontend/build/index.html'));
            });
        }
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Bot is already running');
            return;
        }

        logger.info('🚀 Starting Solana Memecoin Trading Bot v2.1...');
        logger.info(`Mode: ${process.env.PAPER_TRADING === 'true' ? 'PAPER TRADING' : 'LIVE TRADING'}`);

        try {
            // Start all components
            await this.components.scanner.startScanning();
            await this.components.social.startMonitoring();
            await this.components.trading.startTrading();
            
            // Start influencer tracking if configured
            if (process.env.TWITTER_BEARER_TOKEN || true) { // Always start for Reddit
                await this.components.influencer.startTracking();
            }
            
            this.isRunning = true;
            logger.info('✅ All components started successfully');
            
            // Log feature status
            logger.info('Features enabled:', {
                multiSourceScanning: true,
                raydiumMonitoring: !!process.env.HELIUS_API_KEY,
                influencerTracking: true,
                twitterIntegration: !!process.env.TWITTER_BEARER_TOKEN,
                birdeyeIntegration: !!process.env.BIRDEYE_API_KEY
            });
            
        } catch (error) {
            logger.error('Failed to start bot:', error);
            this.stop();
            throw error;
        }
    }

    stop() {
        logger.info('Stopping bot...');
        
        // Stop all components
        this.components.scanner.stopScanning();
        this.components.social.stopMonitoring();
        this.components.trading.stopTrading();
        this.components.influencer.stopTracking();
        
        this.isRunning = false;
        logger.info('✅ Bot stopped');
    }

    async run() {
        const port = process.env.PORT || 3000;
        
        // Start Express server
        this.server = this.app.listen(port, () => {
            logger.info(`🌐 Server running on http://localhost:${port}`);
        });

        // Auto-start bot if configured
        if (process.env.AUTO_START === 'true') {
            await this.start();
        }

        // Graceful shutdown
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            this.stop();
            this.server.close(() => {
                logger.info('Server closed');
                process.exit(0);
            });
        });

        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            this.stop();
            this.server.close(() => {
                logger.info('Server closed');
                process.exit(0);
            });
        });

        // Handle uncaught errors
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception:', error);
            this.stop();
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection at:', promise, 'reason:', reason);
        });
    }
}

// Start the bot
if (require.main === module) {
    require('dotenv').config();
    
    const bot = new MemecoinTradingBot();
    bot.run().catch(error => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = MemecoinTradingBot;