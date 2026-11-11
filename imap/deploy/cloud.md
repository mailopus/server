# Cloud hosting

Both options run the same `compose.yaml` with `TLS_MODE=acme` and the ports set to 993, 465 and 587. With a public host, set `IMAP_BIND=0.0.0.0`, and point your `imap.` and `smtp.` names (DNS-only, grey cloud) at its address. Cloudflare's proxy doesn't carry these ports.

Rough monthly cost, from public price lists, not checked recently:

| Option | Rough monthly |
|---|---|
| DigitalOcean Droplet, Basic 1 GB, reserved IP | $6 ($7.20 with weekly backups) |
| AWS EC2 t4g.micro, public IPv4, 8 GB gp3 | about $10.50 |
| AWS ECS Fargate + NLB | about $30 |

DigitalOcean App Platform is out: it doesn't expose raw TCP ports.

## DigitalOcean Droplet

1. Create an Ubuntu 24.04 Droplet (Basic, 1 GB, any region near you) with Docker from the Marketplace image, and attach a reserved IP.
2. Firewall: allow 22 from your IP, and 993, 465 and 587 from anywhere.
3. On the droplet, clone the repo, `cd imap`, `cp .env.example .env`, set `MAILOPUS_URL`, `TLS_MODE=acme`, `CF_API_TOKEN`, `ACME_EMAIL`, `IMAP_BIND=0.0.0.0` and ports 993, 465 and 587, then `docker compose up -d --build`.
4. Point the A records at the reserved IP.

## AWS EC2

Same as the Droplet: a t4g.micro (arm64) with Amazon Linux 2023 and Docker, an Elastic IP, and a security group allowing 993, 465 and 587. EC2 blocks outbound port 25 by default, which doesn't matter: the proxy sends through Mailopus over HTTPS.

## AWS ECS Fargate behind an NLB

Only worth it if you want no server to patch. Push the image to ECR, run one task (0.25 vCPU, 0.5 GB, arm64), and put an NLB with TCP listeners on 993, 465 and 587 in front. Certificates still come from the proxy (DNS-01), so the NLB passes TCP through and doesn't terminate TLS. Mount EFS at `/data/certs`, or certificates are re-issued on every task start and you'll hit Let's Encrypt's rate limits. Client IPs reach the proxy only with NLB client IP preservation on. Without it, the per-IP lockout sees the NLB's address.
