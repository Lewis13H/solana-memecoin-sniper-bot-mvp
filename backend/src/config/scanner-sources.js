module.exports = {
    PROGRAM_IDS: {
        RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
        PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    },
    
    scanners: {
        pumpfun: {
            enabled: true,
            url: 'wss://pumpportal.fun/api/data',
            priority: 10,
            scanInterval: 30000 // 30 seconds
        },
        moonshot: {
            enabled: false,
            priority: 8,
            scanInterval: 60000 // 1 minute
        },
        raydium: {
            enabled: true,
            priority: 9,
            scanInterval: 45000 // 45 seconds
        },
        dexscreener: {
            enabled: true,
            priority: 7,
            scanInterval: 20000 // 20 seconds (300/min limit)
        },
        birdeye: {
            enabled: !!process.env.BIRDEYE_API_KEY,
            priority: 8,
            scanInterval: 30000 // 30 seconds for free tier
        }
    }
};