import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  env: {
    ADMIN_FIREBASE_API_KEY:
      process.env.ADMIN_FIREBASE_API_KEY ||
      'AIzaSyBMQYHq8sqI9eiDEqiImNAjiRrCuLJoTMQ',
    ADMIN_FIREBASE_AUTH_DOMAIN:
      process.env.ADMIN_FIREBASE_AUTH_DOMAIN ||
      'solarithm-master.firebaseapp.com',
    ADMIN_FIREBASE_PROJECT_ID:
      process.env.ADMIN_FIREBASE_PROJECT_ID || 'solarithm-master',
    ADMIN_FIREBASE_STORAGE_BUCKET:
      process.env.ADMIN_FIREBASE_STORAGE_BUCKET ||
      'solarithm-master.firebasestorage.app',
    ADMIN_FIREBASE_MESSAGING_SENDER_ID:
      process.env.ADMIN_FIREBASE_MESSAGING_SENDER_ID || '560851710395',
    ADMIN_FIREBASE_APP_ID:
      process.env.ADMIN_FIREBASE_APP_ID ||
      '1:560851710395:web:14f29e7ab994666870d49e',
    REACH_FIREBASE_API_KEY:
      process.env.REACH_FIREBASE_API_KEY ||
      'AIzaSyDnSrWcVt-eOKTm1_ncz5eYdIqeO4HKlsE',
    REACH_FIREBASE_AUTH_DOMAIN:
      process.env.REACH_FIREBASE_AUTH_DOMAIN ||
      'solarithm-tools-370ed.firebaseapp.com',
    REACH_FIREBASE_PROJECT_ID:
      process.env.REACH_FIREBASE_PROJECT_ID || 'solarithm-tools-370ed',
    REACH_FIREBASE_STORAGE_BUCKET:
      process.env.REACH_FIREBASE_STORAGE_BUCKET ||
      'solarithm-tools-370ed.firebasestorage.app',
    REACH_FIREBASE_MESSAGING_SENDER_ID:
      process.env.REACH_FIREBASE_MESSAGING_SENDER_ID || '76083145868',
    REACH_FIREBASE_APP_ID:
      process.env.REACH_FIREBASE_APP_ID ||
      '1:76083145868:web:2061d43078c6c9fc8cdfa9',
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
