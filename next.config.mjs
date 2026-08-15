/** @type {import('next').NextConfig} */
const nextConfig = {
  // jsdom (used to run the BotGuard VM for PO token minting) relies on
  // dynamic requires that break when bundled — load it from node_modules.
  serverExternalPackages: ["jsdom"],
};

export default nextConfig;
