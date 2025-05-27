// frontend/src/components/Dashboard.js
import React, { useState, useEffect } from 'react';
import ScannerPerformanceDashboard from './ScannerPerformanceDashboard';


const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

const Dashboard = () => {
    const [pumpFunTokens, setPumpFunTokens] = useState([]);
    const [scannerStats, setScannerStats] = useState({});
    const [status, setStatus] = useState({});
    const [tokens, setTokens] = useState([]);
    const [trades, setTrades] = useState([]);
    const [portfolio, setPortfolio] = useState({ positions: [], summary: {} });
    const [performance, setPerformance] = useState({ daily: [], summary: {} });
    const [influencers, setInfluencers] = useState({ recent_calls: [], tracked_influencers: [] });
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('overview');

    useEffect(() => {
        // Only fetch data when not on scanner tab
        if (activeTab !== 'scanners') {
            fetchData();
            const interval = setInterval(fetchData, 15000); // Update every 15 seconds
            return () => clearInterval(interval);
        }
    }, [activeTab]);

    const fetchData = async () => {
        try {
            setIsLoading(true);
            const [statusRes, tokensRes, tradesRes, portfolioRes, performanceRes, influencersRes,pumpFunRes,scannerStatsRes] = await Promise.all([
                fetch(`${API_BASE}/status`).then(res => res.json()),
                fetch(`${API_BASE}/tokens?limit=20`).then(res => res.json()),
                fetch(`${API_BASE}/trades?limit=20`).then(res => res.json()),
                fetch(`${API_BASE}/portfolio`).then(res => res.json()),
                fetch(`${API_BASE}/performance?days=7`).then(res => res.json()),
                fetch(`${API_BASE}/influencers`)
                    .then(res => res.json())
                    .catch(() => ({ recent_calls: [], tracked_influencers: [] }))
                fetch(`${API_BASE}/tokens/pumpfun?limit=10`)
                    .then(res => res.json())
                    .catch(() => []),
                fetch(`${API_BASE}/scanners/stats`)
                    .then(res => res.json())
                    .catch(() => ({}))    
            ]);

            setStatus(statusRes);
            setTokens(tokensRes);
            setTrades(tradesRes);
            setPortfolio(portfolioRes);
            setPerformance(performanceRes);
            setInfluencers(influencersRes);
            setPumpFunTokens(pumpFunRes);
            setScannerStats(scannerStatsRes)
            setError(null);
        } catch (err) {
            console.error('Error fetching data:', err);
            setError('Failed to fetch data. Is the backend running?');
        } finally {
            setIsLoading(false);
        }
    };

    const handleStart = async () => {
        try {
            await fetch(`${API_BASE}/start`, { method: 'POST' });
            setTimeout(fetchData, 1000);
        } catch (err) {
            alert('Failed to start bot');
        }
    };

    const handleStop = async () => {
        try {
            await fetch(`${API_BASE}/stop`, { method: 'POST' });
            setTimeout(fetchData, 1000);
        } catch (err) {
            alert('Failed to stop bot');
        }
    };

    const toggleFeature = async (feature, currentState) => {
        try {
            await fetch(`${API_BASE}/features/toggle`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    feature: feature,
                    enabled: !currentState
                })
            });
            setTimeout(fetchData, 500);
        } catch (err) {
            alert(`Failed to toggle ${feature}`);
        }
    };

    const formatNumber = (num, decimals = 2) => {
        return Number(num).toFixed(decimals);
    };

    const formatPercentage = (num) => {
        const value = Number(num);
        const color = value >= 0 ? 'text-green-600' : 'text-red-600';
        return <span className={color}>{value >= 0 ? '+' : ''}{value.toFixed(2)}%</span>;
    };

    
    const getTokenAgeMinutes = (discoveredAt) => {
        const age = Date.now() - new Date(discoveredAt).getTime();
        return Math.floor(age / (1000 * 60));
    };

    const getTokenAge = (discoveredAt) => {
        const age = Date.now() - new Date(discoveredAt).getTime();
        const hours = Math.floor(age / (1000 * 60 * 60));
        const minutes = Math.floor((age % (1000 * 60 * 60)) / (1000 * 60));
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    };

    if (isLoading && Object.keys(status).length === 0) {
        return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen">
                <h2 className="text-2xl font-bold text-red-600 mb-4">Connection Error</h2>
                <p className="text-gray-600 mb-6">{error}</p>
                <button 
                    onClick={fetchData}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                    Retry
                </button>
            </div>
        );
    }

    // Show Scanner Performance Dashboard when on scanners tab
    if (activeTab === 'scanners') {
        return (
            <div className="min-h-screen bg-gray-50">
                {/* Header */}
                <header className="mb-6">
                    <div className="bg-white rounded-lg shadow p-6">
                        <div className="flex justify-between items-center">
                            <div>
                                <h1 className="text-3xl font-bold text-gray-800">Solana Memecoin Trading Bot v2.1</h1>
                                <p className="text-gray-600 mt-1">Multi-Source Scanner with Rate Limiting</p>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                    status.status === 'running' 
                                        ? 'bg-green-100 text-green-800' 
                                        : 'bg-red-100 text-red-800'
                                }`}>
                                    {status.status === 'running' ? '● Running' : '○ Stopped'}
                                </span>
                                {status.status === 'running' ? (
                                    <button 
                                        onClick={handleStop}
                                        className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                                    >
                                        Stop Bot
                                    </button>
                                ) : (
                                    <button 
                                        onClick={handleStart}
                                        className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                                    >
                                        Start Bot
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </header>

                {/* Navigation Tabs */}
                <div className="mb-6">
                    <nav className="flex space-x-4">
                        {['overview', 'tokens', 'pumpfun', 'trades', 'influencers', 'performance', 'scanners'].map(tab => (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                className={`px-4 py-2 rounded-lg font-medium ${
                                    activeTab === tab 
                                        ? 'bg-blue-500 text-white' 
                                        : 'bg-white text-gray-700 hover:bg-gray-100'
                                }`}
                            >
                                {tab.charAt(0).toUpperCase() + tab.slice(1)}
                            </button>
                        ))}
                    </nav>
                </div>

                <ScannerPerformanceDashboard />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 p-4">
            {/* Header */}
            <header className="mb-6">
                <div className="bg-white rounded-lg shadow p-6">
                    <div className="flex justify-between items-center">
                        <div>
                            <h1 className="text-3xl font-bold text-gray-800">Solana Memecoin Trading Bot v2.1</h1>
                            <p className="text-gray-600 mt-1">Multi-Source Scanner with Rate Limiting</p>
                        </div>
                        <div className="flex items-center gap-4">
                            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                status.status === 'running' 
                                    ? 'bg-green-100 text-green-800' 
                                    : 'bg-red-100 text-red-800'
                            }`}>
                                {status.status === 'running' ? '● Running' : '○ Stopped'}
                            </span>
                            <span className="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                                {status.mode === 'paper' ? '📝 Paper Trading' : '💰 Live Trading'}
                            </span>
                            {status.status === 'running' ? (
                                <button 
                                    onClick={handleStop}
                                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                                >
                                    Stop Bot
                                </button>
                            ) : (
                                <button 
                                    onClick={handleStart}
                                    className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                                >
                                    Start Bot
                                </button>
                            )}
                        </div>
                    </div>
                    
                    {/* Feature Status */}
                    <div className="mt-4 grid grid-cols-4 gap-4">
                        <div className="flex items-center justify-between p-2 bg-gray-50 rounded">
                            <span className="text-sm">Token Scanner</span>
                            <span className={status.components?.scanner ? 'text-green-600' : 'text-red-600'}>
                                {status.components?.scanner ? '✓' : '✗'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-gray-50 rounded">
                            <span className="text-sm">Social Monitor</span>
                            <button 
                                onClick={() => toggleFeature('social', status.components?.social)}
                                className={`px-2 py-1 rounded text-xs ${
                                    status.components?.social 
                                        ? 'bg-green-100 text-green-700' 
                                        : 'bg-gray-200 text-gray-700'
                                }`}
                            >
                                {status.components?.social ? 'ON' : 'OFF'}
                            </button>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-gray-50 rounded">
                            <span className="text-sm">Influencer Tracking</span>
                            <button 
                                onClick={() => toggleFeature('influencer', status.components?.influencer)}
                                className={`px-2 py-1 rounded text-xs ${
                                    status.components?.influencer 
                                        ? 'bg-green-100 text-green-700' 
                                        : 'bg-gray-200 text-gray-700'
                                }`}
                            >
                                {status.components?.influencer ? 'ON' : 'OFF'}
                            </button>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-gray-50 rounded">
                            <span className="text-sm">Trading Engine</span>
                            <span className={status.components?.trading ? 'text-green-600' : 'text-red-600'}>
                                {status.components?.trading ? '✓' : '✗'}
                            </span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Navigation Tabs */}
            <div className="mb-6">
                <nav className="flex space-x-4">
                    {['overview', 'tokens', 'pumpfun', 'trades', 'influencers', 'performance', 'scanners'].map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-4 py-2 rounded-lg font-medium ${
                                activeTab === tab 
                                    ? 'bg-blue-500 text-white' 
                                    : 'bg-white text-gray-700 hover:bg-gray-100'
                            }`}
                        >
                            {tab.charAt(0).toUpperCase() + tab.slice(1)}
                        </button>
                    ))}
                </nav>
            </div>

            {/* Tab Content - Rest of the original dashboard content */}
            {activeTab === 'overview' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Portfolio Summary */}
                    <div className="bg-white rounded-lg shadow p-6">
                        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">Portfolio Value</h3>
                        <div className="text-3xl font-bold text-gray-900">
                            {portfolio.summary.paper_balance 
                                ? `${formatNumber(portfolio.summary.paper_balance)} SOL`
                                : `${formatNumber(portfolio.summary.total_invested || 0)} SOL`
                            }
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                            {portfolio.summary.total_positions || 0} Active Positions
                        </div>
                    </div>

                    {/* Today's Performance */}
                    <div className="bg-white rounded-lg shadow p-6">
                        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">Today's P&L</h3>
                        <div className="text-3xl font-bold text-gray-900">
                            {formatNumber(performance.summary.avg_daily_pnl || 0)} SOL
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                            Win Rate: {formatPercentage((performance.summary.win_rate || 0) * 100)}
                        </div>
                    </div>

                    {/* Latest Influencer Signal */}
                    <div className="bg-white rounded-lg shadow p-6">
                        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">Latest Signal</h3>
                        {influencers.recent_calls && influencers.recent_calls.length > 0 ? (
                            <div>
                                <div className="text-lg font-semibold">
                                    @{influencers.recent_calls[0].influencer}
                                </div>
                                <div className="text-sm text-gray-600">
                                    {influencers.recent_calls[0].tokens.join(', ')}
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                    Sentiment: {formatNumber(influencers.recent_calls[0].sentiment)}
                                </div>
                            </div>
                        ) : (
                            <div className="text-gray-500">No recent signals</div>
                        )}
                    </div>
                </div>
            )}

            {/* ... rest of the tab content remains the same ... */}
            {activeTab === 'tokens' && (
                <div className="bg-white rounded-lg shadow overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market Cap</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Liquidity</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Social Score</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Risk Score</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {tokens.map((token) => (
                                <tr key={token.address} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                        {token.symbol}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        ${formatNumber(token.market_cap || 0, 0)}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        ${formatNumber(token.liquidity || 0, 0)}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center">
                                            <div className="w-24 bg-gray-200 rounded-full h-2 mr-2">
                                                <div 
                                                    className="bg-blue-500 h-2 rounded-full" 
                                                    style={{ width: `${token.social_score}%` }}
                                                />
                                            </div>
                                            <span className="text-sm text-gray-500">
                                                {formatNumber(token.social_score || 0, 1)}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center">
                                            <div className="w-24 bg-gray-200 rounded-full h-2 mr-2">
                                                <div 
                                                    className={`h-2 rounded-full ${
                                                        token.risk_score < 50 ? 'bg-green-500' : 
                                                        token.risk_score < 70 ? 'bg-yellow-500' : 'bg-red-500'
                                                    }`}
                                                    style={{ width: `${token.risk_score}%` }}
                                                />
                                            </div>
                                            <span className="text-sm text-gray-500">
                                                {formatNumber(token.risk_score || 0, 1)}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {getTokenAge(token.discovered_at)}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                            token.source === 'pumpfun' ? 'bg-purple-100 text-purple-800' :
                                            token.source === 'raydium-direct' ? 'bg-green-100 text-green-800' :
                                            token.source === 'birdeye' ? 'bg-blue-100 text-blue-800' :
                                            token.source === 'dexscreener' ? 'bg-yellow-100 text-yellow-800' :
                                            'bg-gray-100 text-gray-800'
                                        }`}>
                                            {token.source || 'unknown'}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            
            {activeTab === 'pumpfun' && (
                <div className="space-y-6">
                    <div className="bg-white rounded-lg shadow p-6">
                        <h3 className="text-lg font-semibold mb-4">Pump.fun Scanner Status</h3>
                        <div className="grid grid-cols-3 gap-4">
                            <div className="text-center">
                                <div className="text-2xl font-bold text-purple-600">
                                    {scannerStats.pump_fun?.tokensFound || 0}
                                </div>
                                <div className="text-sm text-gray-600">Tokens Found</div>
                            </div>
                            <div className="text-center">
                                <div className="text-2xl font-bold text-green-600">
                                    {scannerStats.pump_fun?.isRunning ? 'Active' : 'Inactive'}
                                </div>
                                <div className="text-sm text-gray-600">Scanner Status</div>
                            </div>
                            <div className="text-center">
                                <div className="text-2xl font-bold text-blue-600">
                                    {scannerStats.pump_fun?.recentTokensCount || 0}
                                </div>
                                <div className="text-sm text-gray-600">Recent Tokens</div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-lg shadow overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-200">
                            <h3 className="text-lg font-semibold">Recent Pump.fun Tokens</h3>
                        </div>
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Token</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Liquidity</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market Cap</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Risk Score</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {pumpFunTokens.map((token) => (
                                    <tr key={token.address} className="hover:bg-gray-50">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div>
                                                <div className="text-sm font-medium text-gray-900">
                                                    {token.symbol}
                                                </div>
                                                <div className="text-xs text-gray-500">
                                                    {token.address.substring(0, 8)}...
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            <span className={\`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full \${getTokenAgeMinutes(token.discovered_at) < 5 ? 'bg-red-100 text-red-800' : getTokenAgeMinutes(token.discovered_at) < 30 ? 'bg-orange-100 text-orange-800' : 'bg-gray-100 text-gray-800'}\`}>
                                                {getTokenAge(token.discovered_at)}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            ${formatNumber(token.liquidity || 0, 0)}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            ${formatNumber(token.market_cap || 0, 0)}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center">
                                                <div className="w-24 bg-gray-200 rounded-full h-2 mr-2">
                                                    <div 
                                                        className={\`h-2 rounded-full \${token.risk_score < 50 ? 'bg-green-500' : token.risk_score < 70 ? 'bg-yellow-500' : 'bg-red-500'}\`}
                                                        style={{ width: \`\${token.risk_score}%\` }}
                                                    />
                                                </div>
                                                <span className="text-sm text-gray-500">
                                                    {formatNumber(token.risk_score || 0, 1)}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 text-purple-800">
                                                Pump.fun
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {pumpFunTokens.length === 0 && (
                                    <tr>
                                        <td colSpan="6" className="px-6 py-4 text-center text-gray-500">
                                            No pump.fun tokens detected yet. Make sure pump.fun monitoring is enabled.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

{/* Continue with other tabs... */}
        </div>
    );
};

export default Dashboard;