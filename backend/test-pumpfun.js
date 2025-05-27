// backend/test-pumpfun.js
// Test script to verify pump.fun scanner is working

require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const PumpFunScanner = require('./src/collectors/scanners/pumpfun_scanner');

async function testPumpFunScanner() {
    console.log('🧪 Testing Pump.fun Scanner...\n');
    
    // Create connection
    const connection = new Connection(
        process.env.HELIUS_API_KEY 
            ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
            : 'https://api.mainnet-beta.solana.com'
    );
    
    console.log(`📡 Using RPC: ${process.env.HELIUS_API_KEY ? 'Helius (Enhanced)' : 'Public Solana'}`);
    
    // Create scanner
    const scanner = new PumpFunScanner();
    
    // Track tokens found
    let tokensFound = 0;
    const tokenDetails = [];
    
    // Set up event listeners
    scanner.on('token', (token) => {
        tokensFound++;
        tokenDetails.push(token);
        
        console.log(`\n🆕 New Pump.fun Token Detected!`);
        console.log(`   Symbol: ${token.symbol}`);
        console.log(`   Address: ${token.address}`);
        console.log(`   Created: ${new Date(token.createdAt).toLocaleString()}`);
        console.log(`   Source: ${token.source}`);
        
        if (token.hasMarketData) {
            console.log(`   Price: $${token.price || 'Unknown'}`);
            console.log(`   Liquidity: $${token.liquidity || 'Unknown'}`);
        }
    });
    
    // Start scanning
    console.log('\n🚀 Starting Pump.fun scanner...');
    console.log('⏰ Will run for 2 minutes to detect new tokens\n');
    
    await scanner.start(connection);
    
    // Show stats every 30 seconds
    const statsInterval = setInterval(() => {
        const stats = scanner.getStats();
        console.log(`\n📊 Scanner Stats:`);
        console.log(`   Tokens Found: ${stats.tokensFound}`);
        console.log(`   Last Token: ${stats.lastTokenTime ? new Date(stats.lastTokenTime).toLocaleString() : 'None yet'}`);
        console.log(`   Errors: ${stats.errors}`);
        console.log(`   Status: ${stats.isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    }, 30000);
    
    // Run for 2 minutes
    await new Promise(resolve => setTimeout(resolve, 120000));
    
    // Stop scanning
    clearInterval(statsInterval);
    await scanner.stop();
    
    // Final report
    console.log('\n\n📋 Final Report:');
    console.log(`Total Tokens Found: ${tokensFound}`);
    
    if (tokenDetails.length > 0) {
        console.log('\nToken Details:');
        tokenDetails.forEach((token, index) => {
            console.log(`\n${index + 1}. ${token.symbol} (${token.address.substring(0, 8)}...)`);
            console.log(`   Age: ${Math.floor((Date.now() - token.createdAt) / 60000)} minutes`);
            console.log(`   Liquidity: $${token.liquidity || 'Unknown'}`);
        });
    } else {
        console.log('\nNo tokens were detected during the test period.');
        console.log('This could mean:');
        console.log('1. No new pump.fun tokens were created during this time');
        console.log('2. The scanner needs more time to detect tokens');
        console.log('3. There might be a connection issue');
        
        if (!process.env.HELIUS_API_KEY) {
            console.log('\n💡 TIP: Using Helius RPC with enhanced websockets will improve detection!');
        }
    }
    
    console.log('\n✅ Test completed!');
    process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
    console.error('\n❌ Error:', error);
    process.exit(1);
});

// Run the test
testPumpFunScanner().catch(console.error);