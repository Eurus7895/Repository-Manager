---
id: cloud-iac
name: Cloud and infrastructure as code
category: security
appliesTo: ["**/*.tf", "**/*.tfvars", "**/*.bicep", "**/cloudformation/**", "**/*.template.json", "**/*.template.yaml", "**/serverless.yml", "**/k8s/**", "**/kubernetes/**", "**/helm/**", "**/charts/**", "**/docker-compose*.yml", "**/Dockerfile", "**/*.dockerfile"]
references: AWS Well-Architected Framework, Security Pillar (identity and access management, data protection, infrastructure protection, detection); CWE-732, CWE-284, CWE-311, CWE-250
---
Identity and access:
- IAM or role policies with "*" actions or resources where a narrower one is possible; wildcard principals; trust policies any account can assume (least privilege, CWE-732).
- Long-lived access keys in resources or variables instead of roles or workload identity.

Data protection:
- Storage, databases, queues or backups without encryption at rest, or with encryption disabled explicitly (CWE-311).
- Endpoints or load balancers that allow plain HTTP or old TLS versions.
- Buckets or blobs that are public, or whose policy grants read or write to everyone.

Infrastructure:
- Security groups or firewall rules open to 0.0.0.0/0 or ::/0 on administrative or database ports (22, 3389, 5432, 3306, 6379, 27017).
- Containers that run as root, privileged, with host networking or host paths, or without resource limits (CWE-250).
- Secrets in plain environment variables of task definitions, manifests or compose files instead of a secret store.

Detection:
- Logging, audit trails or flow logs turned off for resources that hold data.

Cite the resource and attribute. Defaults that the provider applies when an attribute is absent count only when you know that default.
