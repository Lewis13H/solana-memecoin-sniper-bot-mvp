const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
    constructor() {
        const dbPath = path.join(__dirname, '../../../data/trading.db');
        console.log('Attempting to create database at:', dbPath);
        this.db = new Database(dbPath);
        this.initTables();
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
                status TEXT DEFAULT 'discovered'
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
    }

    // Token operations
    addToken(tokenData) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tokens 
            (address, symbol, name, market_cap, liquidity, holders, social_score, risk_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(
            tokenData.address,
            tokenData.symbol,
            tokenData.name,
            tokenData.marketCap,
            tokenData.liquidity,
            tokenData.holders,
            tokenData.socialScore || 0,
            tokenData.riskScore || 0
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