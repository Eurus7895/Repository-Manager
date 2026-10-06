---
id: cloud-iac
name: Cloud and infrastructure as code
category: security
appliesTo: ["**/*.tf", "**/*.tf.json", "**/*.tfvars", "**/*.bicep", "**/cloudformation/**", "**/template.yaml", "**/template.yml", "**/template.json", "**/*.template.json", "**/*.template.yaml", "**/serverless.yml", "**/serverless.yaml", "**/k8s/**", "**/kubernetes/**", "**/manifests/**", "**/kustomization.yaml", "**/helm/**", "**/charts/**", "**/docker-compose*.yml", "**/docker-compose*.yaml", "**/compose.yml", "**/compose.yaml", "**/Dockerfile", "**/*.dockerfile", "**/Pulumi.yaml"]
references: AWS Well-Architected Framework, Security Pillar (identity and access management, data protection, infrastructure protection, detection); CWE-732, CWE-284, CWE-311, CWE-319, CWE-250, CWE-770, CWE-778
---
Identity and access:
- IAM or role policies with "*" actions or resources where a narrower one is possible; wildcard principals; trust policies any account can assume (CWE-732, CWE-284).
- Long-lived access keys in resources or variables instead of roles or workload identity.

Data protection:
- Encryption at rest disabled explicitly, or absent where the service does not encrypt by default (CWE-311). Amazon S3 encrypts new objects by default since January 2023: a bucket without an encryption block is not a finding by itself.
- Endpoints or load balancers that allow plain HTTP or TLS older than 1.2 (CWE-319).
- Buckets or blobs that are public, or whose policy grants read or write to everyone.

Infrastructure:
- Security groups or firewall rules open to 0.0.0.0/0 or ::/0 on administrative or data ports: 22, 23, 3389, 2375, 5432, 3306, 1433, 6379, 9200, 27017.
- Containers that run as root, privileged, with host networking or host paths (CWE-250); no memory or CPU limits where one workload can starve the node (CWE-770).
- Secrets in plain environment variables of task definitions, manifests or compose files instead of a secret store.

Detection:
- Logging, audit trails or flow logs turned off for resources that hold data (CWE-778).

Cite the resource and attribute. A default the provider applies when an attribute is absent counts only when you know that default for this provider; otherwise say so under limitations.
