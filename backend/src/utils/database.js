const Database = require('better-sqlite3');
const path = require('path');
const logger = require('./logger');

class DatabaseManager {
    constructor() {
        const dbPath = path.join(__dirname, '../../../data/trading.db');
        console.log('Attempting to create database at:', dbPath);
        this.db = new Database(dbPath);
        this.initTables();
        this.migrateDatabase();
    }

    initTables() {
        // Tokens table - tracks discovered tokens
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT UNIQUE NOT NULL,
                symbol TEXT,
                name TEXT,
                market_cap REAL,
                liquidity REAL,
                holders INTEGER,
                social_score REAL DEFAULT 0,
                risk_score REAL DEFAULT 0,
                discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'discovered',
                source TEXT DEFAULT 'unknown',
                metadata TEXT,
                is_pump_fun BOOLEAN DEFAULT 0,
                deployment_type TEXT
            )
        `);

        // Trades table - records all trading activity
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_address TEXT NOT NULL,
                side TEXT NOT NULL,
                amount REAL NOT NULL,
                price REAL NOT NULL,
                sol_amount REAL NOT NULL,
                signature TEXT UNIQUE,
                status TEXT DEFAULT 'pending',
                profit_loss REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                executed_at DATETIME
            )
        `);

        // Portfolio table - current positions
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS portfolio (
                token_address TEXT PRIMARY KEY,
                balance REAL NOT NULL,
                avg_buy_price REAL NOT NULL,
                total_invested REAL NOT NULL,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Performance metrics table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS performance_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL,
                total_trades INTEGER,
                winning_trades INTEGER,
                total_pnl REAL,
                win_rate REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Influencer calls table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS influencer_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                influencer TEXT NOT NULL,
                platform TEXT NOT NULL,
                tokens TEXT,
                sentiment REAL,
                signal_strength REAL,
                timestamp DATETIME,
                outcome TEXT,
                profit_loss REAL
            )
        `);
    }

    migrateDatabase() {
        try {
            // Check if columns exist
            const tableInfo = this.db.prepare("PRAGMA table_info(tokens)").all();
            const columns = tableInfo.map(col => col.name);
            
            // Add missing columns
            if (!columns.includes('source')) {
                this.db.exec("ALTER TABLE tokens ADD COLUMN source TEXT DEFAULT 'unknown'");
            }
            if (!columns.includes('metadata')) {
                this.db.exec("ALTER TABLE tokens ADD COLUMN metadata TEXT");
            }
            if (!columns.includes('is_pump_fun')) {
                this.db.exec("ALTER TABLE tokens ADD COLUMN is_pump_fun BOOLEAN DEFAULT 0");
            }
            if (!columns.includes('deployment_type')) {
                this.db.exec("ALTER TABLE tokens ADD COLUMN deployment_type TEXT");
            }
            
            logger.info('Database migration completed');
        } catch (error) {
            logger.error('Database migration error:', error);
        }
    }

    // Token operations
    addToken(tokenData) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tokens 
            (address, symbol, name, market_cap, liquidity, holders, social_score, risk_score, source, metadata, is_pump_fun, deployment_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        // Parse metadata if it's an object
        const metadata = typeof tokenData.metadata === 'object' 
            ? JSON.stringify(tokenData.metadata) 
            : tokenData.metadata;
        
        return stmt.run(
            tokenData.address,
            tokenData.symbol,
            tokenData.name,
            tokenData.marketCap,
            tokenData.liquidity,
            tokenData.holders,
            tokenData.socialScore || 0,
            tokenData.riskScore || 0,
            tokenData.source || 'unknown',
            metadata || null,
            tokenData.isPumpFun ? 1 : 0,
            tokenData.deploymentType || null
        );
    }

    getViableTokens(limit = 20) {
        const stmt = this.db.prepare(`
            SELECT * FROM tokens 
            WHERE risk_score < 80
            AND liquidity > ?
            ORDER BY social_score DESC, discovered_at DESC
            LIMIT ?
        `);
        return stmt.all(process.env.MIN_LIQUIDITY || 500, limit);
    }

    getPumpFunTokens(limit = 20) {
        const stmt = this.db.prepare(`
            SELECT * FROM tokens 
            WHERE is_pump_fun = 1
            OR source = 'pumpfun'
            ORDER BY discovered_at DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    getTokensBySource(source, limit = 20) {
        const stmt = this.db.prepare(`
            SELECT * FROM tokens 
            WHERE source = ?
            ORDER BY discovered_at DESC
            LIMIT ?
        `);
        return stmt.all(source, limit);
    }

    // Trade tracking
    recordTrade(tradeData) {
        const stmt = this.db.prepare(`
            INSERT INTO trades 
            (token_address, side, amount, price, sol_amount, signature, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(
            tradeData.tokenAddress,
            tradeData.side,
            tradeData.amount,
            tradeData.price,
            tradeData.solAmount,
            tradeData.signature,
            tradeData.status || 'pending'
        );
    }

    updateTradeStatus(signature, status, profitLoss = null) {
        const stmt = this.db.prepare(`
            UPDATE trades 
            SET status = ?, profit_loss = ?, executed_at = CURRENT_TIMESTAMP
            WHERE signature = ?
        `);
        return stmt.run(status, profitLoss, signature);
    }

    getDailyPnL() {
        const stmt = this.db.prepare(`
            SELECT SUM(profit_loss) as daily_pnl 
            FROM trades 
            WHERE DATE(executed_at) = DATE('now') 
            AND status = 'completed'
        `);
        return stmt.get()?.daily_pnl || 0;
    }
}

module.exports = DatabaseManager;