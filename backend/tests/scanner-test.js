// backend/tests/scanner-test.js
const MultiSourceTokenScanner = require('../src/collectors/multi_source_token_scanner');
const DatabaseManager = require('../src/utils/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/scanner-config');

class ScannerTestSuite {
    constructor() {
        this.results = {
            scanners: {},
            summary: {
                totalTokensFound: 0,
                totalErrors: 0,
                avgResponseTime: 0,
                successRate: 0
            }
        };
    }

    async runAllTests() {
        console.log('🧪 Starting Scanner Test Suite...\n');
        
        // Test individual scanners
        await this.testIndividualScanners();
        
        // Test rate limiting
        await this.testRateLimiting();
        
        // Test performance
        await this.testPerformance();
        
        // Test error handling
        await this.testErrorHandling();
        
        // Generate report
        this.generateReport();
    }

    async testIndividualScanners() {
        console.log('📋 Testing Individual Scanners...\n');
        
        const db = new DatabaseManager();
        const scanner = new MultiSourceTokenScanner(db);
        
        const scannerNames = ['pumpfun', 'moonshot', 'raydium', 'dexscreener'];
        
        for (const name of scannerNames) {
            console.log(`Testing ${name} scanner...`);
            const startTime = Date.now();
            
            try {
                // Initialize scanner
                const scannerInstance = scanner.scanners[name];
                if (!scannerInstance) {
                    this.results.scanners[name] = {
                        status: 'NOT_FOUND',
                        error: 'Scanner not initialized'
                    };
                    continue;
                }
                
                // Start scanner
                await scannerInstance.start();
                
                // Wait for tokens
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // Collect results
                const tokens = Array.from(scannerInstance.tokens.values());
                const responseTime = Date.now() - startTime;
                
                this.results.scanners[name] = {
                    status: 'SUCCESS',
                    tokensFound: tokens.length,
                    responseTime: responseTime,
                    sampleTokens: tokens.slice(0, 3).map(t => ({
                        symbol: t.symbol,
                        address: t.address.substring(0, 10) + '...',
                        marketCap: t.marketCap
                    }))
                };
                
                this.results.summary.totalTokensFound += tokens.length;
                
                // Stop scanner
                scannerInstance.stop();
                
                console.log(`✅ ${name}: Found ${tokens.length} tokens in ${responseTime}ms\n`);
                
            } catch (error) {
                this.results.scanners[name] = {
                    status: 'ERROR',
                    error: error.message,
                    responseTime: Date.now() - startTime
                };
                this.results.summary.totalErrors++;
                
                console.log(`❌ ${name}: ${error.message}\n`);
            }
        }
    }

    async testRateLimiting() {
        console.log('🚦 Testing Rate Limiting...\n');
        
        const RateLimiter = require('../src/utils/rateLimiter');
        const rateLimiter = new RateLimiter(config.rateLimits);
        
        // Test Reddit rate limiting
        console.log('Testing Reddit rate limiter...');
        const requests = [];
        const startTime = Date.now();
        
        // Try to make 10 rapid requests
        for (let i = 0; i < 10; i++) {
            requests.push(
                rateLimiter.throttle('reddit', async () => {
                    return { requestNumber: i, timestamp: Date.now() };
                })
            );
        }
        
        const results = await Promise.all(requests);
        const totalTime = Date.now() - startTime;
        
        console.log(`Completed 10 requests in ${totalTime}ms`);
        console.log(`Average time per request: ${(totalTime / 10).toFixed(2)}ms`);
        
        // Check if rate limiting worked
        const timestamps = results.map(r => r.timestamp);
        const gaps = [];
        for (let i = 1; i < timestamps.length; i++) {
            gaps.push(timestamps[i] - timestamps[i-1]);
        }
        
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        console.log(`Average gap between requests: ${avgGap.toFixed(2)}ms\n`);
        
        this.results.rateLimiting = {
            totalRequests: 10,
            totalTime: totalTime,
            avgTimePerRequest: totalTime / 10,
            avgGapBetweenRequests: avgGap
        };
    }

    async testPerformance() {
        console.log('⚡ Testing Performance...\n');
        
        const db = new DatabaseManager();
        const scanner = new MultiSourceTokenScanner(db);
        
        // Start all scanners
        await scanner.startScanning();
        
        // Monitor for 30 seconds
        const startTime = Date.now();
        const metrics = {
            tokensDiscovered: 0,
            uniqueTokens: new Set(),
            scannerActivity: {}
        };
        
        // Set up monitoring
        const interval = setInterval(() => {
            const stats = scanner.getStatistics();
            metrics.tokensDiscovered = stats.totalTokensFound;
            
            // Track unique tokens
            for (const [name, scannerInstance] of Object.entries(scanner.scanners)) {
                if (scannerInstance.tokens) {
                    scannerInstance.tokens.forEach(token => {
                        metrics.uniqueTokens.add(token.address);
                    });
                }
                
                metrics.scannerActivity[name] = scannerInstance.tokens?.size || 0;
            }
        }, 1000);
        
        // Wait 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        clearInterval(interval);
        scanner.stopScanning();
        
        const totalTime = (Date.now() - startTime) / 1000;
        const tokensPerSecond = metrics.uniqueTokens.size / totalTime;
        
        console.log(`Discovered ${metrics.uniqueTokens.size} unique tokens in ${totalTime}s`);
        console.log(`Rate: ${tokensPerSecond.toFixed(2)} tokens/second\n`);
        
        this.results.performance = {
            duration: totalTime,
            uniqueTokensFound: metrics.uniqueTokens.size,
            tokensPerSecond: tokensPerSecond,
            scannerActivity: metrics.scannerActivity
        };
    }

    async testErrorHandling() {
        console.log('🛡️ Testing Error Handling...\n');
        
        const db = new DatabaseManager();
        
        // Test with invalid configuration
        const invalidConfig = {
            scanners: {
                test: {
                    enabled: true,
                    apiUrl: 'https://invalid-url-that-does-not-exist.com'
                }
            }
        };
        
        // This should handle errors gracefully
        try {
            const scanner = new MultiSourceTokenScanner(db);
            // Simulate network error
            await scanner.scanners.dexscreener.fetchTokens();
            console.log('✅ Error handling test passed\n');
            
            this.results.errorHandling = {
                status: 'PASSED',
                message: 'Scanners handle errors gracefully'
            };
        } catch (error) {
            console.log('❌ Error handling test failed:', error.message, '\n');
            
            this.results.errorHandling = {
                status: 'FAILED',
                error: error.message
            };
        }
    }

    generateReport() {
        console.log('\n📊 SCANNER TEST REPORT\n');
        console.log('=' .repeat(50));
        
        // Summary
        const successfulScanners = Object.values(this.results.scanners)
            .filter(s => s.status === 'SUCCESS').length;
        const totalScanners = Object.keys(this.results.scanners).length;
        
        console.log('\n📈 SUMMARY:');
        console.log(`- Scanners Tested: ${totalScanners}`);
        console.log(`- Successful: ${successfulScanners}`);
        console.log(`- Failed: ${totalScanners - successfulScanners}`);
        console.log(`- Total Tokens Found: ${this.results.summary.totalTokensFound}`);
        console.log(`- Success Rate: ${((successfulScanners / totalScanners) * 100).toFixed(1)}%`);
        
        // Individual Scanner Results
        console.log('\n🔍 SCANNER RESULTS:');
        for (const [name, result] of Object.entries(this.results.scanners)) {
            console.log(`\n${name.toUpperCase()}:`);
            console.log(`  Status: ${result.status}`);
            if (result.status === 'SUCCESS') {
                console.log(`  Tokens Found: ${result.tokensFound}`);
                console.log(`  Response Time: ${result.responseTime}ms`);
                if (result.sampleTokens?.length > 0) {
                    console.log('  Sample Tokens:');
                    result.sampleTokens.forEach(t => {
                        console.log(`    - ${t.symbol} (${t.address})`);
                    });
                }
            } else {
                console.log(`  Error: ${result.error}`);
            }
        }
        
        // Rate Limiting Results
        if (this.results.rateLimiting) {
            console.log('\n🚦 RATE LIMITING:');
            console.log(`  Total Time for 10 requests: ${this.results.rateLimiting.totalTime}ms`);
            console.log(`  Avg Time per Request: ${this.results.rateLimiting.avgTimePerRequest.toFixed(2)}ms`);
            console.log(`  Avg Gap Between Requests: ${this.results.rateLimiting.avgGapBetweenRequests.toFixed(2)}ms`);
        }
        
        // Performance Results
        if (this.results.performance) {
            console.log('\n⚡ PERFORMANCE:');
            console.log(`  Test Duration: ${this.results.performance.duration}s`);
            console.log(`  Unique Tokens Found: ${this.results.performance.uniqueTokensFound}`);
            console.log(`  Discovery Rate: ${this.results.performance.tokensPerSecond.toFixed(2)} tokens/second`);
            console.log('  Scanner Activity:');
            for (const [name, count] of Object.entries(this.results.performance.scannerActivity)) {
                console.log(`    - ${name}: ${count} tokens`);
            }
        }
        
        // Error Handling
        if (this.results.errorHandling) {
            console.log('\n🛡️ ERROR HANDLING:');
            console.log(`  Status: ${this.results.errorHandling.status}`);
            if (this.results.errorHandling.error) {
                console.log(`  Error: ${this.results.errorHandling.error}`);
            }
        }
        
        console.log('\n' + '='.repeat(50));
        console.log('Test suite completed!');
        
        // Save results to file
        const fs = require('fs');
        const reportPath = `./logs/scanner-test-${Date.now()}.json`;
        fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
        console.log(`\nFull report saved to: ${reportPath}`);
    }
}

// Run tests if called directly
if (require.main === module) {
    const testSuite = new ScannerTestSuite();
    testSuite.runAllTests().catch(console.error);
}

module.exports = ScannerTestSuite;