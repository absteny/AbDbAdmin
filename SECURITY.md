# Security reporting

Use **Security → Advisories → Report a vulnerability** on GitHub if private
reporting is enabled. Otherwise, ask the maintainer for a private contact
channel without posting vulnerability details publicly.

Include the version, database engine, deployment configuration, and expected
behavior. Reproduce issues using synthetic data and authorized test systems.
Keep passwords, keys, connection strings, and database exports out of reports.

## Deployment

Restrict the database account privileges assigned to saved connections. For
host-only use, install with `sh install.sh --local`. For remote use, use HTTPS
or an encrypted tunnel. Keep the persistent volume and backups private. Run
the installer in a private terminal because it prints credentials.
