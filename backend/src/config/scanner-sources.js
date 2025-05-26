// backend/src/config/scanner-sources.js
module.exports = {
    PROGRAM_IDS: {
        PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
        RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
        ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
    },
    
    scanners: {
        pumpfun: {
            enabled: true,
            url: 'wss://pumpportal.fun/api/data',
            priority: 10
        },
        moonshot: {
            enabled: true,
            priority: 9
        },
        raydium: {
            enabled: true,
            priority: 8
        },
        orca: {
            enabled: true,
            priority: 7
        },
        dexscreener: {
            enabled: true,
            priority: 5
        },
        birdeye: {
            enabled: process.env.BIRDEYE_API_KEY ? true : false,
            priority: 6
        }
    }
};