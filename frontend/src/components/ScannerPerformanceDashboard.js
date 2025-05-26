import React, { useState, useEffect } from 'react';

const ScannerPerformanceDashboard = () => {
    const [scannerStatus, setScannerStatus] = useState({});
    const [performanceMetrics, setPerformanceMetrics] = useState({});
    const [rateLimitStatus, setRateLimitStatus] = useState({});
    const [recentErrors, setRecentErrors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

    useEffect(() => {
        fetchPerformanceData();
        const interval = setInterval(fetchPerformanceData, 5000); // Update every 5 seconds
        return () => clearInterval(interval);
    }, []);

    const fetchPerformanceData = async () => {
        try {
            const [statusRes, performanceRes, rateLimitRes, errorsRes] = await Promise.all([
                fetch(`${API_BASE}/scanners/status`).then(res => res.json()),
                fetch(`${API_BASE}/scanners/performance`).then(res => res.json()),
                fetch(`${API_BASE}/scanners/rate-limits`).then(res => res.json()),
                fetch(`${API_BASE}/scanners/errors`).then(res => res.json())
            ]);

            setScannerStatus(statusRes);
            setPerformanceMetrics(performanceRes);
            setRateLimitStatus(rateLimitRes);
            setRecentErrors(errorsRes.slice(0, 10));
            setIsLoading(false);
        } catch (error) {
            console.error('Error fetching performance data:', error);
            setIsLoading(false);
        }
    };

    const getScannerStatusColor = (scanner) => {
        if (!scanner.enabled) return 'bg-gray-400';
        if (!scanner.running) return 'bg-yellow-400';
        if (scanner.errors > 0) return 'bg-red-400';
        return 'bg-green-400';
    };

    const formatUptime = (ms) => {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    };

    if (isLoading) {
        return <div className="flex items-center justify-center p-8">Loading scanner performance data...</div>;
    }

    return (
        <div className="p-6 bg-gray-50 min-h-screen">
            <h1 className="text-3xl font-bold mb-6">Scanner Performance Dashboard</h1>

            {/* Scanner Status Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {Object.entries(scannerStatus).map(([name, status]) => (
                    <div key={name} className="bg-white rounded-lg shadow p-4">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="font-semibold capitalize">{name}</h3>
                            <div className={`w-3 h-3 rounded-full ${getScannerStatusColor(status)}`} />
                        </div>
                        
                        <div className="space-y-1 text-sm">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Status:</span>
                                <span className="font-medium">
                                    {status.enabled ? (status.running ? 'Running' : 'Stopped') : 'Disabled'}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Tokens:</span>
                                <span className="font-medium">{status.tokensFound || 0}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Last Update:</span>
                                <span className="font-medium">
                                    {status.lastUpdate ? new Date(status.lastUpdate).toLocaleTimeString() : 'Never'}
                                </span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Performance Metrics */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                {/* Discovery Rate Chart */}
                <div className="bg-white rounded-lg shadow p-6">
                    <h2 className="text-xl font-semibold mb-4">Token Discovery Rate</h2>
                    <div className="space-y-4">
                        {Object.entries(performanceMetrics.discoveryRates || {}).map(([scanner, rate]) => (
                            <div key={scanner}>
                                <div className="flex justify-between mb-1">
                                    <span className="capitalize">{scanner}</span>
                                    <span className="text-sm font-medium">{rate.toFixed(2)} tokens/min</span>
                                </div>
                                <div className="w-full bg-gray-200 rounded-full h-2">
                                    <div 
                                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                                        style={{ width: `${Math.min((rate / 5) * 100, 100)}%` }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Response Times */}
                <div className="bg-white rounded-lg shadow p-6">
                    <h2 className="text-xl font-semibold mb-4">Average Response Times</h2>
                    <div className="space-y-4">
                        {Object.entries(performanceMetrics.responseTimes || {}).map(([scanner, time]) => (
                            <div key={scanner}>
                                <div className="flex justify-between mb-1">
                                    <span className="capitalize">{scanner}</span>
                                    <span className="text-sm font-medium">{time}ms</span>
                                </div>
                                <div className="w-full bg-gray-200 rounded-full h-2">
                                    <div 
                                        className={`h-2 rounded-full transition-all duration-300 ${
                                            time < 1000 ? 'bg-green-500' : 
                                            time < 3000 ? 'bg-yellow-500' : 'bg-red-500'
                                        }`}
                                        style={{ width: `${Math.min((time / 5000) * 100, 100)}%` }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Rate Limit Status */}
            <div className="bg-white rounded-lg shadow p-6 mb-8">
                <h2 className="text-xl font-semibold mb-4">API Rate Limit Status</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {Object.entries(rateLimitStatus).map(([api, status]) => (
                        <div key={api} className="text-center">
                            <div className="text-sm text-gray-600 mb-1 capitalize">{api}</div>
                            <div className="text-2xl font-bold">
                                {status.remaining}/{status.limit}
                            </div>
                            <div className="text-xs text-gray-500">
                                Resets in {Math.floor(status.resetIn / 60)}m
                            </div>
                            <div className="mt-2">
                                <div className="w-full bg-gray-200 rounded-full h-2">
                                    <div 
                                        className={`h-2 rounded-full ${
                                            status.remaining / status.limit > 0.5 ? 'bg-green-500' :
                                            status.remaining / status.limit > 0.2 ? 'bg-yellow-500' :
                                            'bg-red-500'
                                        }`}
                                        style={{ width: `${(status.remaining / status.limit) * 100}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* System Health Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white rounded-lg shadow p-6">
                    <h3 className="text-lg font-semibold mb-2">System Uptime</h3>
                    <div className="text-3xl font-bold text-green-600">
                        {formatUptime(performanceMetrics.uptime || 0)}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                        Since {new Date(Date.now() - (performanceMetrics.uptime || 0)).toLocaleString()}
                    </div>
                </div>

                <div className="bg-white rounded-lg shadow p-6">
                    <h3 className="text-lg font-semibold mb-2">Total Tokens Discovered</h3>
                    <div className="text-3xl font-bold text-blue-600">
                        {performanceMetrics.totalTokensDiscovered || 0}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                        {performanceMetrics.uniqueTokens || 0} unique tokens
                    </div>
                </div>

                <div className="bg-white rounded-lg shadow p-6">
                    <h3 className="text-lg font-semibold mb-2">Error Rate</h3>
                    <div className={`text-3xl font-bold ${
                        (performanceMetrics.errorRate || 0) < 5 ? 'text-green-600' :
                        (performanceMetrics.errorRate || 0) < 10 ? 'text-yellow-600' :
                        'text-red-600'
                    }`}>
                        {(performanceMetrics.errorRate || 0).toFixed(1)}%
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                        {performanceMetrics.totalErrors || 0} errors in last hour
                    </div>
                </div>
            </div>

            {/* Recent Errors */}
            <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">Recent Errors</h2>
                {recentErrors.length === 0 ? (
                    <p className="text-gray-500">No recent errors</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full">
                            <thead>
                                <tr className="border-b">
                                    <th className="text-left py-2 px-4">Time</th>
                                    <th className="text-left py-2 px-4">Scanner</th>
                                    <th className="text-left py-2 px-4">Error</th>
                                    <th className="text-left py-2 px-4">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recentErrors.map((error, index) => (
                                    <tr key={index} className="border-b hover:bg-gray-50">
                                        <td className="py-2 px-4 text-sm">
                                            {new Date(error.timestamp).toLocaleTimeString()}
                                        </td>
                                        <td className="py-2 px-4 text-sm capitalize">{error.scanner}</td>
                                        <td className="py-2 px-4 text-sm">{error.message}</td>
                                        <td className="py-2 px-4">
                                            <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                                                error.resolved ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                                            }`}>
                                                {error.resolved ? 'Resolved' : 'Active'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ScannerPerformanceDashboard;