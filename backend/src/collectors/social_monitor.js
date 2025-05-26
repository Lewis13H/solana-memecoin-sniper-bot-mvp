// backend/src/collectors/social_monitor.js
const axios = require('axios');
const logger = require('../utils/logger');

class SocialMonitor {
    constructor(database) {
        this.db = database;
        this.isMonitoring = false;
        this.monitorInterval = 120000; // Increased to 2 minutes to avoid rate limits
        
        // Rate limiting
        this.redditLastRequest = 0;
        this.redditMinDelay = 2000; // 2 seconds between Reddit requests
        this.rateLimitBackoff = 60000; // 1 minute backoff on 429
        this.isRateLimited = false;
        
        // Sentiment keywords
        this.positiveKeywords = [
            'moon', 'pump', 'gem', 'bullish', 'buy', 'hold', 
            'diamond', 'rocket', 'gains', 'profit', 'winner',
            'best', 'amazing', 'love', 'fire', 'based', 'chad'
        ];
        
        this.negativeKeywords = [
            'dump', 'crash', 'bearish', 'sell', 'scam', 'rug',
            'dead', 'avoid', 'terrible', 'worst', 'panic', 'rekt'
        ];
        
        this.influencerMultipliers = {
            high: 3.0,    // Well-known crypto influencers
            medium: 2.0,  // Regular traders with following
            low: 1.0      // General users
        };
    }

    async startMonitoring() {
        if (this.isMonitoring) return;
        
        this.isMonitoring = true;
        logger.info('📱 Social monitor started (with rate limit protection)');

        // Initial scan with delay
        setTimeout(() => this.scanSocialSignals(), 5000);

        // Continuous monitoring
        this.monitorTimer = setInterval(async () => {
            try {
                if (!this.isRateLimited) {
                    await this.scanSocialSignals();
                } else {
                    logger.info('Skipping social scan due to rate limiting');
                }
            } catch (error) {
                logger.error('Social monitoring error:', error);
            }
        }, this.monitorInterval);
    }

    async scanSocialSignals() {
        try {
            const activeTokens = this.db.getViableTokens(5); // Reduced to scan fewer tokens at once
            
            for (const token of activeTokens) {
                // Add delay between tokens
                await this.delay(2000);
                
                const socialData = await this.aggregateSocialData(token);
                await this.updateTokenSocialScore(token, socialData);
            }
        } catch (error) {
            logger.error('Error scanning social signals:', error);
        }
    }

    async aggregateSocialData(token) {
        const signals = [];
        
        // Reddit monitoring (with better rate limiting)
        if (!this.isRateLimited) {
            try {
                const redditSignals = await this.scanReddit(token);
                signals.push(...redditSignals);
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    logger.warn('Reddit rate limit hit - backing off for 1 minute');
                    this.isRateLimited = true;
                    setTimeout(() => {
                        this.isRateLimited = false;
                        logger.info('Reddit rate limit cooldown complete');
                    }, this.rateLimitBackoff);
                } else {
                    logger.warn(`Reddit scan failed for ${token.symbol}:`, error.message);
                }
            }
        }

        // Twitter monitoring (if API available)
        if (process.env.TWITTER_BEARER_TOKEN) {
            try {
                const twitterSignals = await this.scanTwitter(token);
                signals.push(...twitterSignals);
            } catch (error) {
                logger.warn(`Twitter scan failed for ${token.symbol}`);
            }
        }

        // Calculate aggregate metrics
        return this.calculateSocialMetrics(signals);
    }

    async scanReddit(token) {
        // Respect rate limits
        return [];
        const now = Date.now();
        const timeSinceLastRequest = now - this.redditLastRequest;
        
        if (timeSinceLastRequest < this.redditMinDelay) {
            await this.delay(this.redditMinDelay - timeSinceLastRequest);
        }
        
        this.redditLastRequest = Date.now();
        
        // Only scan one subreddit at a time to reduce requests
        const subreddit = 'CryptoMoonShots'; // Most relevant for memecoins
        const signals = [];

        try {
            const response = await axios.get(
                `https://www.reddit.com/r/${subreddit}/search.json`,
                {
                    params: {
                        q: token.symbol,
                        sort: 'new',
                        limit: 10, // Reduced limit
                        t: 'day',
                        restrict_sr: true
                    },
                    headers: { 
                        'User-Agent': 'MemecoinBot/1.0 (by /u/yourusername)' // Add a real Reddit username
                    },
                    timeout: 10000
                }
            );

            const posts = response.data?.data?.children || [];
            
            for (const post of posts) {
                const sentiment = this.analyzeSentiment(
                    post.data.title + ' ' + (post.data.selftext || '')
                );
                
                signals.push({
                    platform: 'reddit',
                    content: post.data.title,
                    sentiment: sentiment,
                    engagement: post.data.score + post.data.num_comments,
                    influence: this.calculateRedditInfluence(post.data),
                    timestamp: new Date(post.data.created_utc * 1000)
                });
            }
        } catch (error) {
            throw error; // Re-throw to handle rate limiting in caller
        }

        return signals;
    }

    async scanTwitter(token) {
        try {
            const response = await axios.get(
                'https://api.twitter.com/2/tweets/search/recent',
                {
                    params: {
                        query: `$${token.symbol} -is:retweet lang:en`,
                        max_results: 25, // Reduced from 50
                        'tweet.fields': 'public_metrics,created_at,author_id'
                    },
                    headers: {
                        'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
                    },
                    timeout: 10000
                }
            );

            return (response.data?.data || []).map(tweet => ({
                platform: 'twitter',
                content: tweet.text,
                sentiment: this.analyzeSentiment(tweet.text),
                engagement: tweet.public_metrics.like_count + 
                           tweet.public_metrics.retweet_count * 2,
                influence: 1.0, // Would need user data for real influence
                timestamp: new Date(tweet.created_at)
            }));
        } catch (error) {
            logger.error('Twitter API error:', error);
            return [];
        }
    }

    analyzeSentiment(text) {
        const words = text.toLowerCase().split(/\s+/);
        let score = 0;
        
        for (const word of words) {
            if (this.positiveKeywords.includes(word)) score += 1;
            if (this.negativeKeywords.includes(word)) score -= 1;
        }
        
        // Check for strong signals
        if (text.includes('🚀')) score += 2;
        if (text.includes('🌙')) score += 1;
        if (text.includes('💎')) score += 1;
        if (text.includes('📈')) score += 1;
        if (text.includes('⚠️')) score -= 2;
        if (text.includes('🚨')) score -= 2;
        
        // Normalize to -1 to 1 range
        const normalizedScore = Math.max(-1, Math.min(1, score / Math.max(words.length / 10, 1)));
        
        return normalizedScore;
    }

    calculateRedditInfluence(postData) {
        let influence = 1.0;
        
        // Post engagement
        if (postData.score > 100) influence *= 1.5;
        else if (postData.score > 50) influence *= 1.3;
        else if (postData.score > 20) influence *= 1.1;
        
        // Awards indicate quality
        if (postData.total_awards_received > 0) influence *= 1.2;
        
        return influence;
    }

    calculateSocialMetrics(signals) {
        if (signals.length === 0) {
            return { score: 0, sentiment: 0, momentum: 0, signals: [] };
        }

        // Time decay - recent signals matter more
        const now = Date.now();
        const weightedSignals = signals.map(signal => {
            const ageHours = (now - signal.timestamp) / (1000 * 60 * 60);
            const timeWeight = Math.exp(-ageHours / 12); // 12-hour half-life
            
            return {
                ...signal,
                weight: timeWeight * signal.influence
            };
        });

        // Calculate metrics
        const totalWeight = weightedSignals.reduce((sum, s) => sum + s.weight, 0) || 1;
        const avgSentiment = weightedSignals.reduce(
            (sum, s) => sum + s.sentiment * s.weight, 0
        ) / totalWeight;
        
        // Momentum = number of mentions in last hour
        const recentSignals = signals.filter(
            s => (now - s.timestamp) < 60 * 60 * 1000
        );
        
        // Social score calculation
        const volumeScore = Math.min(100, recentSignals.length * 10);
        const sentimentScore = (avgSentiment + 1) * 50; // Convert to 0-100
        const engagementScore = Math.min(100, 
            weightedSignals.reduce((sum, s) => sum + s.engagement, 0) / 10
        );
        
        const finalScore = (volumeScore * 0.3 + sentimentScore * 0.4 + engagementScore * 0.3);
        
        return {
            score: finalScore,
            sentiment: avgSentiment,
            momentum: recentSignals.length,
            signals: weightedSignals.slice(0, 10) // Top 10 signals
        };
    }

    async updateTokenSocialScore(token, socialData) {
        try {
            const stmt = this.db.db.prepare(`
                UPDATE tokens 
                SET social_score = ? 
                WHERE address = ?
            `);
            stmt.run(socialData.score, token.address);
            
            if (socialData.score > 50) {
                logger.info(`📈 High social score for ${token.symbol}: ${socialData.score.toFixed(1)}`);
            }
        } catch (error) {
            logger.error('Error updating social score:', error);
        }
    }

    // Utility function to add delays
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stopMonitoring() {
        this.isMonitoring = false;
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer);
        }
        logger.info('Social monitor stopped');
    }
}

module.exports = SocialMonitor;