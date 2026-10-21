# @viventure/cli

The `viventure` command line for the Viventure WhatsApp platform.

```bash
npx @viventure/cli --help
```

Or install it once:

```bash
npm install -g @viventure/cli
```

## Getting started

```bash
viventure login <your-api-key>     # stores the key in ~/.viventure/config.json
viventure projects list             # the projects the key can reach
viventure instances list            # the instances of the current project
viventure messages send --instance inst_xxx --to +254700000000 --text "hello"
```

A **personal access token** manages every project of the account; a
project token can only act inside its own project. Name the project with
`--project <slug>` when you are using an account-wide token.

Full documentation: https://whatsapp.nextmavens.com/docs
