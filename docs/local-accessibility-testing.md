# Local accessibility testing

The full local accessibility gate uses the repository-pinned Python Playwright package and
Chromium. Homebrew Python follows PEP 668 and does not permit package installation into its
managed environment, so browser dependencies belong in a host-persistent virtual environment
instead of a checkout-local environment.

Install or refresh that environment once per development host:

```sh
make setup-a11y
```

The default location is `$XDG_DATA_HOME/cityscroll/a11y-python`, falling back to
`$HOME/.local/share/cityscroll/a11y-python`. Override it with `CROL_A11Y_VENV` when a host has a
different shared application-data layout. The setup command is idempotent and uses
`.github/actions/setup-playwright/requirements.txt`, the same pin used by CI.

From any checkout on that host, run:

```sh
make a11y
```

`make a11y` puts the persistent environment first on `PATH` and runs the complete browser
preflight. It does not create or update a virtual environment. Run `make setup-a11y` again only
when the pinned requirements change or Chromium needs to be refreshed.
