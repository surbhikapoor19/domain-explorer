// CRACO config (UNIT #15) — lets create-react-app (react-scripts 5 / webpack 5)
// bundle the copilot's lazy `@xenova/transformers` query embedder.
//
// transformers.js ships Node-only optional dependencies (`sharp` for image
// decoding, `onnxruntime-node` for the native ONNX runtime). In the browser it
// uses `onnxruntime-web` (WASM) instead and never executes the Node paths — but
// webpack still tries to RESOLVE those requires at build time and fails. We
// alias them to `false` so webpack drops them, and set node-core fallbacks to
// `false` for the same reason. We also stop webpack from choking on the source
// maps that ship inside onnxruntime-web / transformers.
module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      webpackConfig.resolve = webpackConfig.resolve || {};

      // Node-only optional deps of @xenova/transformers — not used in-browser.
      webpackConfig.resolve.alias = {
        ...(webpackConfig.resolve.alias || {}),
        sharp$: false,
        'onnxruntime-node$': false,
      };

      // Node core modules webpack 5 no longer auto-polyfills. The browser build
      // of transformers never hits these, so resolve them to nothing.
      webpackConfig.resolve.fallback = {
        ...(webpackConfig.resolve.fallback || {}),
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        os: false,
        url: false,
        worker_threads: false,
        perf_hooks: false,
        'onnxruntime-node': false,
        sharp: false,
      };

      // Allow importing .wasm assets (onnxruntime-web) as static resources.
      webpackConfig.module = webpackConfig.module || {};
      webpackConfig.module.rules = webpackConfig.module.rules || [];
      webpackConfig.module.rules.push({
        test: /\.wasm$/,
        type: 'asset/resource',
      });

      // Silence "Failed to parse source map" warnings from prebuilt deps that
      // reference missing .ts sources (onnxruntime-web, transformers).
      webpackConfig.ignoreWarnings = [
        ...(webpackConfig.ignoreWarnings || []),
        /Failed to parse source map/,
      ];

      return webpackConfig;
    },
  },
};
