# Contributing & Community Submission

## Submit to awesome-opencode

[awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) is the primary community curated list for OpenCode plugins.

### Steps

1. Fork [awesome-opencode/awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
2. Create `data/plugins/opencode-agent-factory.yaml` with this content:

```yaml
name: opencode-agent-factory
repo: https://github.com/MunhozThiago/opencode-agent-factory-plugin
tagline: Dynamic multi-agent orchestration with runtime agent generation and consensus protocols
description: |
  Analyzes prompts at runtime, generates specialized agent teams, executes them in parallel with dependency resolution, and synthesizes results using consensus strategies (debate, voting, expert review, hierarchical).

  Features:
  - Runtime agent generation: no hardcoded models, adapts to your current session
  - Parallel DAG execution with automatic dependency injection
  - 5 consensus protocols for reconciling multiple agent outputs
  - Configurable timeout and retry policies
  - Built-in /orchestrate command and orchestrate custom tool
tags:
  - multi-agent
  - orchestration
  - consensus
  - parallel
  - dynamic-agents
  - workflow
scope:
  - project
min_version: "0.1.0"
homepage: https://github.com/MunhozThiago/opencode-agent-factory-plugin
installation: |
  ```bash
  npm install opencode-agent-factory-plugin
  ```
  Add to your `opencode.json`:
  ```json
  {
    "plugin": ["opencode-agent-factory-plugin"]
  }
  ```
  Use via the `/orchestrate` command or the `orchestrate` tool.
```

3. Commit and submit a Pull Request
4. Fill out the PR template checklist

### Validation

- Automated YAML schema validation runs on PR
- Maintainer reviews for relevance and quality
- Once approved, merged to `main` and auto-listed in README

---

## Submit to opencode.im

[opencode.im](https://opencode.im) is a community plugin marketplace.

### Steps

1. Go to [opencode.im/submit](https://opencode.im/submit)
2. Enter the GitHub URL: `https://github.com/MunhozThiago/opencode-agent-factory-plugin`
3. Click "Import Plugin"
4. Verify the auto-populated fields
5. Submit

---

## Submit to OpenCode Ecosystem

The [OpenCode Ecosystem](https://opencode.ai/docs/ecosystem/) page lists plugins from the community. Plugins listed in awesome-opencode are automatically considered.

---

## After Acceptance

Once listed, update the README to include badges:

```markdown
[![awesome-opencode](https://awesome-opencode.badgen.rs/badge/opencode-agent-factory)](https://github.com/awesome-opencode/awesome-opencode)
[![opencode.im](https://img.shields.io/badge/opencode.im-plugin-blue)](https://opencode.im/plugins/opencode-agent-factory-plugin)
```
