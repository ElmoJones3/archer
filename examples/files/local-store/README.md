# Local file store

This example composes the product-neutral `@archer/files` contracts with
`@archer/files/fs`. It publishes a tree, closes the first attachment, reopens
the same physical store, restores and verifies content, handles a valid missing
reference, and closes without deleting durable objects.

From the repository root:

```sh
pnpm exampleFilesLocal
```

The temporary directory selects persistence only. Host paths and filesystem
behavior do not participate in `BlobRef` or `TreeRef` identity.
