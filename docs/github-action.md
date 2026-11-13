# GitHub Action

A composite action that sends the signed deploy request, follows the deployment and **fails the job unless the new version became healthy**. It needs `curl`, `openssl` and `jq` on the runner (GitHub-hosted runners have them).

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      # Build and push the image yourself: Keelson only ever pulls.
      - run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
          docker build -t ghcr.io/acme/web:${{ github.sha }} .
          docker push ghcr.io/acme/web:${{ github.sha }}
      - uses: 0x2u/keelson/action@v0.1.0
        with:
          url: https://agent.example.com
          app: web
          tag: ${{ github.sha }}          # default; or digest: sha256:...
          deploy-secret: ${{ secrets.KEELSON_DEPLOY_SECRET }}
          read-token: ${{ secrets.KEELSON_READ_TOKEN }}
```

Optional inputs: `timeout` (seconds, default 600), `ca-cert`, `client-cert` and `client-key` (PEM contents, for a private CA or mutual TLS), and `committed-at`, the time of the commit being deployed (RFC 3339), which defaults to the timestamp of the pushed commit and lets the agent measure the [lead time of a change](./reference/delivery.md); set it to `""` to send nothing. Outputs: `deployment-id` and `status`. The action refuses a plain `http://` URL unless `allow-insecure-http` is `true`, since the read token would travel unencrypted. Inputs reach the script through environment variables, not shell interpolation, and the tag and digest are validated before they go into the request body.

The job fails when the deployment ends as `failed`, `rolled_back` or `rollback_failed`, when the agent rejects the signature (wrong secret, or a runner clock more than 5 minutes off), when the app is unknown, when a deployment is already running (`409`), and when the timeout is reached. A timeout only stops the wait. The deployment keeps running on the agent and finishes there.
