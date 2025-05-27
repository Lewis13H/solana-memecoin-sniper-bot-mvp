// backend/scripts/migrate-db.js
// Run this script to update your existing database with pump.fun fields

const Database = require('better-sqlite3');
const path = require('path');

function migrateDatabase() {
    console.log('🔧 Starting database migration for pump.fun support...\n');
    
    const dbPath = path.join(__dirname, '../../data/trading.db');
    console.log(`📁 Database path: ${dbPath}`);
    
    try {
        const db = new Database(dbPath);
        
        // Get current table structure
        const tableInfo = db.prepare("PRAGMA table_info(tokens)").all();
        const columns = tableInfo.map(col => col.name);
        console.log(`\n📊 Current columns: ${columns.join(', ')}\n`);
        
        // Track migrations
        let migrationsApplied = 0;
        
        // Add source column
        if (!columns.includes('source')) {
            console.log('➕ Adding "source" column...');
            db.exec("ALTER TABLE tokens ADD COLUMN source TEXT DEFAULT 'unknown'");
            migrationsApplied++;
        } else {
            console.log('✓ Column "source" already exists');
        }
        
        // Add metadata column
        if (!columns.includes('metadata')) {
            console.log('➕ Adding "metadata" column...');
            db.exec("ALTER TABLE tokens ADD COLUMN metadata TEXT");
            migrationsApplied++;
        } else {
            console.log('✓ Column "metadata" already exists');
        }
        
        // Add is_pump_fun column
        if (!columns.includes('is_pump_fun')) {
            console.log('➕ Adding "is_pump_fun" column...');
            db.exec("ALTER TABLE tokens ADD COLUMN is_pump_fun BOOLEAN DEFAULT 0");
            migrationsApplied++;
        } else {
            console.log('✓ Column "is_pump_fun" already exists');
        }
        
        // Add deployment_type column
        if (!columns.includes('deployment_type')) {
            console.log('➕ Adding "deployment_type" column...');
            db.exec("ALTER TABLE tokens ADD COLUMN deployment_type TEXT");
            migrationsApplied++;
        } else {
            console.log('✓ Column "deployment_type" already exists');
        }
        
        // Create influencer_calls table if it doesn't exist
        console.log('\n📋 Checking influencer_calls table...');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const tableNames = tables.map(t => t.name);
        
        if (!tableNames.includes('influencer_calls')) {
            console.log('➕ Creating "influencer_calls" table...');
            db.exec(`
                CREATE TABLE influencer_calls (
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
            migrationsApplied++;
        } else {
            console.log('✓ Table "influencer_calls" already exists');
        }
        
        // Add indexes for better performance
        console.log('\n🔍 Adding indexes...');
        try {
            db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_source ON tokens(source)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_pump ON tokens(is_pump_fun)");
            console.log('✓ Indexes created successfully');
        } catch (error) {
            console.log('ℹ️  Some indexes may already exist');
        }
        
        // Update existing tokens with source data
        console.log('\n🔄 Updating existing tokens...');
        const updateCount = db.prepare(`
            UPDATE tokens 
            SET source = 'dexscreener' 
            WHERE source = 'unknown' 
            AND discovered_at < datetime('now', '-1 day')
        `).run();
        
        console.log(`✓ Updated ${updateCount.changes} existing tokens`);
        
        // Close database
        db.close();
        
        // Summary
        console.log('\n✅ Migration completed successfully!');
        console.log(`📊 Total migrations applied: ${migrationsApplied}`);
        
        if (migrationsApplied === 0) {
            console.log('\nℹ️  Your database was already up to date!');
        } else {
            console.log('\n🎉 Your database is now ready for pump.fun integration!');
        }
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        console.log('\n💡 Tips:');
        console.log('1. Make sure the bot is not running');
        console.log('2. Check that the database file exists');
        console.log('3. Ensure you have write permissions');
        process.exit(1);
    }
}

// Run migration
console.log('🚀 Pump.fun Database Migration Tool\n');
migrateDatabase();