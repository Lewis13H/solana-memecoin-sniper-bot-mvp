// backend/src/utils/database.js
const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
    constructor() {
        const dbPath = path.join(__dirname, '../../../data/trading.db');
        console.log('Attempting to create database at:', dbPath);
        this.db = new Database(dbPath);
        this.initTables();
        this.upgradeSchema();
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
                metadata TEXT DEFAULT '{}'
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
                executed_at DATETIME,
                strategy TEXT,
                source TEXT
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

        // Influencer calls table (if it doesn't exist)
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

        // Scanner performance table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS scanner_performance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scanner_name TEXT NOT NULL,
                tokens_found INTEGER DEFAULT 0,
                last_success DATETIME,
                failures INTEGER DEFAULT 0,
                avg_discovery_time REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    upgradeSchema() {
        // Check if columns exist and add them if they don't
        const tableInfo = this.db.prepare("PRAGMA table_info(tokens)").all();
        const columnNames = tableInfo.map(col => col.name);

        // Add source column if it doesn't exist
        if (!columnNames.includes('source')) {
            this.db.exec("ALTER TABLE tokens ADD COLUMN source TEXT DEFAULT 'unknown'");
            console.log('Added source column to tokens table');
        }

        // Add priority column if it doesn't exist
        if (!columnNames.includes('priority')) {
            this.db.exec("ALTER TABLE tokens ADD COLUMN priority INTEGER DEFAULT 50");
            console.log('Added priority column to tokens table');
        }

        // Add discovery_metadata column if it doesn't exist
        if (!columnNames.includes('discovery_metadata')) {
            this.db.exec("ALTER TABLE tokens ADD COLUMN discovery_metadata TEXT");
            console.log('Added discovery_metadata column to tokens table');
        }

        // Add strategy and source to trades table
        const tradesTableInfo = this.db.prepare("PRAGMA table_info(trades)").all();
        const tradesColumnNames = tradesTableInfo.map(col => col.name);

        if (!tradesColumnNames.includes('strategy')) {
            this.db.exec("ALTER TABLE trades ADD COLUMN strategy TEXT");
        }

        if (!tradesColumnNames.includes('source')) {
            this.db.exec("ALTER TABLE trades ADD COLUMN source TEXT");
        }

        // Create indexes for better performance
        try {
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_source ON tokens(source)");
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_priority ON tokens(priority DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_discovered ON tokens(discovered_at DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_trades_token_source ON trades(token_address, source)");
        } catch (error) {
            console.log('Indexes may already exist:', error.message);
        }
    }

    // Token operations
    addToken(tokenData) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tokens 
            (address, symbol, name, market_cap, liquidity, holders, social_score, risk_score, source, priority, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const metadata = tokenData.metadata ? JSON.stringify(tokenData.metadata) : '{}';
        
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
            tokenData.priority || 50,
            metadata
        );
    }

    getViableTokens(limit = 20) {
        const stmt = this.db.prepare(`
            SELECT *,
                   CASE 
                       WHEN source = 'pumpfun' THEN priority + 20
                       WHEN source = 'moonshot' THEN priority + 15
                       WHEN source = 'raydium' THEN priority + 10
                       ELSE priority
                   END as adjusted_priority
            FROM tokens 
            WHERE risk_score < 80
            AND liquidity > ?
            ORDER BY adjusted_priority DESC, social_score DESC, discovered_at DESC
            LIMIT ?
       `);
        return stmt.all(process.env.MIN_LIQUIDITY || 500, limit);
    }

    getTokensBySource(source, limit = 20) {
        const stmt = this.db.prepare(`
            SELECT * FROM tokens 
            WHERE source = ?
            AND risk_score < 80
            ORDER BY priority DESC, discovered_at DESC
            LIMIT ?
        `);
        return stmt.all(source, limit);
    }

    getRecentHighPriorityTokens(minutes = 60, limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM tokens 
            WHERE discovered_at > datetime('now', '-' || ? || ' minutes')
            AND priority > 70
            ORDER BY priority DESC, discovered_at DESC
            LIMIT ?
        `);
        return stmt.all(minutes, limit);
    }

    // Trade tracking
    recordTrade(tradeData) {
        const stmt = this.db.prepare(`
            INSERT INTO trades 
            (token_address, side, amount, price, sol_amount, signature, status, strategy, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        // Get token source
        const tokenStmt = this.db.prepare('SELECT source FROM tokens WHERE address = ?');
        const token = tokenStmt.get(tradeData.tokenAddress);
        const tokenSource = token ? token.source : 'unknown';
        
        return stmt.run(
            tradeData.tokenAddress,
            tradeData.side,
            tradeData.amount,
            tradeData.price,
            tradeData.solAmount,
            tradeData.signature,
            tradeData.status || 'pending',
            tradeData.strategy || 'momentum',
            tokenSource
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

    // Scanner performance tracking
    updateScannerPerformance(scannerName, tokensFound) {
        const stmt = this.db.prepare(`
            INSERT INTO scanner_performance (scanner_name, tokens_found, last_success)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(scanner_name) DO UPDATE SET
                tokens_found = tokens_found + ?,
                last_success = CURRENT_TIMESTAMP,
                failures = 0
        `);
        
        try {
            stmt.run(scannerName, tokensFound, tokensFound);
        } catch (error) {
            // Table might not have unique constraint, just insert
            const insertStmt = this.db.prepare(`
                INSERT INTO scanner_performance (scanner_name, tokens_found, last_success)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `);
            insertStmt.run(scannerName, tokensFound);
        }
    }

    recordScannerFailure(scannerName, error) {
        const stmt = this.db.prepare(`
            UPDATE scanner_performance 
            SET failures = failures + 1
            WHERE scanner_name = ?
        `);
        stmt.run(scannerName);
    }

    getScannerStats() {
        const stmt = this.db.prepare(`
            SELECT * FROM scanner_performance
            ORDER BY tokens_found DESC
        `);
        return stmt.all();
    }

    // Performance analytics by source
    getPerformanceBySource(days = 30) {
        const stmt = this.db.prepare(`
            SELECT 
                t.source,
                COUNT(*) as total_trades,
                SUM(CASE WHEN tr.profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(tr.profit_loss) as total_pnl,
                AVG(tr.profit_loss) as avg_pnl,
                MAX(tr.profit_loss) as best_trade,
                MIN(tr.profit_loss) as worst_trade
            FROM trades tr
            JOIN tokens t ON tr.token_address = t.address
            WHERE tr.executed_at > datetime('now', '-' || ? || ' days')
            AND tr.status = 'completed'
            GROUP BY t.source
            ORDER BY total_pnl DESC
        `);
        return stmt.all(days);
    }
}

module.exports = DatabaseManager;