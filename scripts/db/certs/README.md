# Database CA certificates

`supabase-prod-ca-2021.crt` is Supabase's public root CA ("Supabase Root 2021 CA", valid until 2031-04-26,
SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`),
downloaded from `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt` (the file
the Supabase dashboard offers under Database → SSL configuration). It is public, not a secret.

Set `DATABASE_SSL_CA` to its path (in the API image: `/app/scripts/db/certs/supabase-prod-ca-2021.crt`) and the
API, migrations and demo loader connect with full certificate and host-name verification, whatever `sslmode`
the `DATABASE_URL` carries. Deployed environments refuse to start without verified database TLS.
