# @syncular/client-plugin-encryption

End-to-end encryption plugin for the Syncular client. Supports field-level encryption with key sharing between devices.

## Install

```bash
npm install @syncular/client-plugin-encryption
```

## Usage

```ts
import {
  createFieldEncryptionPlugin,
  createStaticFieldEncryptionKeys,
} from '@syncular/client-plugin-encryption';

const encryption = createFieldEncryptionPlugin({
  rules: [{ scope: 'user', table: 'notes', fields: ['body'] }],
  keys: createStaticFieldEncryptionKeys({
    keys: { default: 'base64url:...' },
  }),
});
```

## Documentation

- Encryption guide: https://syncular.dev/docs/build/encryption

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
