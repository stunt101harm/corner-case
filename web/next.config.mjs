/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // @coral-xyz/anchor and web3.js are written for node; in the browser
    // bundle the node built-ins they conditionally touch must resolve to
    // nothing, and Buffer must exist as a global.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
      crypto: false,
    };
    config.plugins.push(
      new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
    );
    return config;
  },
};

export default nextConfig;
