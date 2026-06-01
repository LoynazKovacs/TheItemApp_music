const { withNativeFederation, shareAll, share } = require('@angular-architects/native-federation/config');

module.exports = withNativeFederation({
  name: 'music',

  exposes: {
    './MusicStudioPrefab': './src/app/prefabs/music-studio/exposed.ts',
    './MusicPlayerPrefab': './src/app/prefabs/music-player/exposed.ts',
  },

  shared: {
    ...shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }),
    ...share({ '@loynazkovacs/theitemapp-platform-sdk': { singleton: true, strictVersion: true, requiredVersion: 'auto' } }),
  },

  skip: [
    'rxjs/ajax',
    'rxjs/fetch',
    'rxjs/testing',
    'rxjs/webSocket',
  ],

  features: {
    ignoreUnusedDeps: true,
  },
});
