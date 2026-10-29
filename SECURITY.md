# Security policy

## Supported versions

Open Nova is in alpha, so only the newest release gets fixes. Please check the problem on the
[latest release](https://github.com/kman1898/Open-Nova/releases) (and on `main` if you can) before reporting.

| Version | Supported |
| --- | --- |
| Newest release (alpha) | yes |
| `main` | yes (fixes land here first) |
| Older releases | no |

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub: open the repository's
[Security tab](https://github.com/kman1898/Open-Nova/security) and choose **Report a vulnerability**
([direct link](https://github.com/kman1898/Open-Nova/security/advisories/new)).

Say what you found, how to reproduce it, the version (Help ▸ About) and system, and what you think the impact is. Please
leave your own network addresses, logins and show files out of it. You'll get an answer as soon as possible, updates in
the advisory, and credit when the fix is published unless you'd rather stay anonymous.

## How Open Nova is exposed

Open Nova has no user accounts. Keep this in mind when you run it:

- **The app server** (port 8765) answers other devices on your network by default, so an iPad or a second laptop can
  use it. Anyone who can reach that port can do what you can in the app, including writes to processors once unlocked.
  On a network you don't control, start it with `--local-only`.
- **The hardware helper** (port 8790) listens on this computer only and accepts requests only from the app's own
  addresses.
- **H series web logins** you save are kept in your user settings folder (not in the project), in the form the H's own
  web page sends them. That is not strong encryption: protect the folder like any password file.
- **Recordings and reports** stay on your computer. Passwords and tokens are left out; a report is only shared when you
  send it. A Wireshark capture you add to a report goes in unchanged.

## The alpha unlock is not security

The alpha builds start read-only, and every write needs an unlock code. That code is a speed bump against sending to a
wall by accident. It is the same for every alpha tester, its salted hash is in the repository, and anyone with the source
can switch the lock off. A way around it is not a vulnerability; a write that goes out while the app says it is locked
is a bug: please [report it](https://github.com/kman1898/Open-Nova/issues/new/choose).

Reports that are especially useful:

- a request from a web page or another device that makes the helper talk to a processor;
- reading or writing files outside Open Nova's data folder through the app server;
- a password, token or H login that ends up in a recording, log or report;
- anything in a release zip that shouldn't be there.
