'use client';

import { useEffect } from 'react';
import { cursor } from './(utils)/cursor-setup';

export default function Home() {
  useEffect(() => {
    // Demo cursor movement when component mounts
    const demoElements = [
      'dashboard-title',
      'stats-users',
      'stats-revenue',
      'stats-conversion',
      'chart-container',
      'order-link-1',
      'action-products',
      'action-reports',
      'action-analytics',
      'action-support',
    ];

    const positions: [number, number][] = [];

    demoElements.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        const rect = element.getBoundingClientRect();
        positions.push([rect.left + rect.width / 2, rect.top + rect.height / 2]);
      }
    });

    cursor.scheduleMoves(positions);
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <main className="p-6 bg-white rounded-lg shadow-md max-w-4xl w-full border-2 border-dashed border-gray-300">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-gray-800" id="dashboard-title">
            Product Dashboard
          </h1>
          <p className="text-sm text-gray-500">Mock Product Analytics</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div
            className="bg-gray-50 p-4 rounded border border-dashed border-gray-300"
            id="stats-users"
          >
            <span className="text-gray-500 text-sm">Total Users</span>
            <p className="text-2xl font-semibold text-gray-700">12,543</p>
          </div>
          <div
            className="bg-gray-50 p-4 rounded border border-dashed border-gray-300"
            id="stats-revenue"
          >
            <span className="text-gray-500 text-sm">Revenue</span>
            <p className="text-2xl font-semibold text-gray-700">$34,567</p>
          </div>
          <div
            className="bg-gray-50 p-4 rounded border border-dashed border-gray-300"
            id="stats-conversion"
          >
            <span className="text-gray-500 text-sm">Conversion Rate</span>
            <p className="text-2xl font-semibold text-gray-700">5.7%</p>
          </div>
        </div>

        <div className="mb-6">
          <h2 className="text-lg font-medium text-gray-700 mb-3">Activity Overview</h2>
          <div
            className="h-48 bg-gray-50 rounded border border-dashed border-gray-300 flex items-center justify-center"
            id="chart-container"
          >
            <span className="text-gray-400">Chart Mockup</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border border-dashed border-gray-300 rounded p-4">
            <h3 className="text-md font-medium text-gray-700 mb-2">Recent Orders</h3>
            <div className="space-y-2">
              {[1, 2, 3].map((item) => (
                <div
                  key={item}
                  className="flex justify-between items-center p-2 bg-gray-50 rounded"
                >
                  <span className="text-gray-600">Order #{item}0234</span>
                  <a href="#" className="text-blue-500 text-sm" id={`order-link-${item}`}>
                    View
                  </a>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-dashed border-gray-300 rounded p-4">
            <h3 className="text-md font-medium text-gray-700 mb-2">Quick Actions</h3>
            <div className="grid grid-cols-2 gap-2">
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-products"
              >
                Manage Products
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-users"
              >
                User Management
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-settings"
              >
                Settings
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-reports"
              >
                Reports
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-analytics"
              >
                Analytics
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-support"
              >
                Support
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-integrations"
              >
                Integrations
              </a>
              <a
                href="#"
                className="bg-gray-50 p-3 rounded text-center text-gray-600 border border-dashed border-gray-300"
                id="action-export"
              >
                Export Data
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
