# Licensing and data handling

## Source, dependencies, and container

AbDbAdmin is available under the [MIT license](LICENSE). Keep the copyright
and license notices when redistributing the software. The MIT warranty and
liability terms apply subject to applicable law.

The license notices for the pinned npm dependencies and bundled Inter font
are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). The Inter license
also accompanies the font files. These components retain their own terms.

The Dockerfile uses the [official Node.js image](https://hub.docker.com/_/node)
on Debian. Before distributing a built image, review the exact base image
and packages, preserve their notices, and fulfill any applicable source
distribution obligations. Review additional contractual and regulatory
requirements for hosted or commercial distributions separately.

## Names and trademarks

AbDbAdmin is the project name. PostgreSQL, MySQL, and MariaDB are mentioned to
describe compatibility. The project has no affiliation with or endorsement
from their owners. For commercial use, check the project name and similar
marks in the countries and product classes where you plan to use it.
Consult the [WIPO Global Brand Database](https://www.wipo.int/en/web/global-brand-database/index),
[TMview](https://www.tmdn.org/tmview/advancedSearch.html), and relevant national
registries.

## Self-hosting and personal data

The instance stores account names, password hashes, session and permission
metadata, encrypted connection profiles, and an audit log on the operator's
server. Audit records include available actor names, target identifiers,
timestamps, actions, and outcomes. The application sends queries to configured
database servers and presents the results to authorized users. CSV exports
are downloaded by the user. The built-in demo uses synthetic data.

The application does not send telemetry or database contents to the project
maintainer. Hosting, reverse proxies, and backup services may handle data
independently.

Operators determine their lawful access, retention and deletion policies,
safeguards, and incident response. Their obligations depend on jurisdiction
and role. Consult applicable laws, including
[GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) or
[Russia's Federal Law No. 152-FZ](https://www.consultant.ru/document/cons_doc_LAW_61801/)
where relevant. For commercial distribution in the European Union, also
review the [Cyber Resilience Act guidance](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source).
