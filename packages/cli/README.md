# @viventure/cli

The `viventure` command line for the Viventure WhatsApp platform.

```bash
npx @viventure/cli --registry https://registry.nextmavens.com --help
```

Or install it once. The package lives on the Next Mavens registry, so
the registry is named unless npm already knows the `@viventure` scope:

```bash
npm install -g @viventure/cli --registry https://registry.nextmavens.com
```

Then it updates itself:

```bash
viventure update            # to the latest version
viventure update --check    # just report whether one is available
viventure update --to 1.0.7 # to a particular version
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
