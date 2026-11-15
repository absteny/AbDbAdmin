# AbDbAdmin — Self-hosted database administration for MySQL, MariaDB, and PostgreSQL

AbDbAdmin is an open-source web-based SQL client and database admin panel
that runs in Docker. Connect to multiple database servers, browse and edit
table data, manage schemas, and run SQL from your browser. MySQL and MariaDB
support SSH key tunnels and live server monitoring.

- Browse tables, filter rows, edit records, and import or export data.
- Explore table relationships and preview SQL before changing a schema.
- Save database connections, manage user access, and review SQL in the audit log.

## 1. Install on your computer

Install Docker Engine 28 or newer with Docker Compose V2, or a current Docker Desktop. Open a terminal
in the project directory. On Linux, macOS, or Windows with WSL, run:

```sh
sh install.sh --local
```

Open [http://127.0.0.1:8099](http://127.0.0.1:8099).

1. Enter **admin** and the password under **Panel sign-in** in the terminal.
2. Change that password using **Change password**.
3. Choose **English** or **Russian** using the language selector. English is
   the default, and your selection is remembered by that browser.
4. Use **Theme** on the sign-in screen or in the sidebar to switch between
   **Light** and **Dark**. Your browser remembers your choice.

Local-only mode opens directly to the panel sign-in form without a Basic
Auth prompt. Installations started without this mode still require the
separate **gateway** credentials before panel sign-in.

The `--local` flag overrides any external bind address in `.env`, publishes
the Docker port on **127.0.0.1 only**, and makes AbDbAdmin reject other Host
headers and standard forwarded headers. It also shows only the local URL.
Leave this instance out of any reverse proxy, tunnel, or separate forwarding
setup if you want access from the host only. Use [Docker Engine 28 or newer](https://docs.docker.com/engine/network/port-publishing/) for localhost port isolation.
The flag controls inbound access
to AbDbAdmin. It can still connect to a database on another machine.

### Windows PowerShell

Run the commands below one at a time in Windows PowerShell.

#### Install Windows prerequisites

- **WSL 2**. If Docker Desktop reports that WSL is missing, open PowerShell
  as Administrator and run:

  ```powershell
  wsl --install --no-distribution
  ```

  Restart Windows after installation. Docker Desktop can use WSL 2 without
  a separate Linux distribution. See the [Microsoft WSL guide](https://learn.microsoft.com/windows/wsl/install)
  and the [Docker WSL 2 guide](https://docs.docker.com/desktop/features/wsl/).
- **Docker Desktop**. If Docker Desktop is missing, install it using the
  [official Windows installer](https://docs.docker.com/desktop/setup/install/windows-install/)
  and use the WSL 2 backend. Start Docker Desktop and run `docker version`.
  Continue once the output includes a **Server** section. Docker Engine 28
  or newer is required for local-only mode.
- **Git for Windows**. If `git --version` fails, install Git:

  ```powershell
  winget install --id Git.Git --exact --source winget
  ```

  Close PowerShell, open a new window and check `git --version` again.
  If WinGet is unavailable, use the [Git for Windows installer](https://git-scm.com/install/windows).

#### Clone and start AbDbAdmin

For a new installation, clone the repository into a folder you own.

```powershell
Set-Location $HOME
git clone https://github.com/absteny/AbDbAdmin.git
Set-Location .\AbDbAdmin
& .\install.ps1
```

The script uses the `compose.yaml` beside it, regardless of the current directory.
If running Compose yourself, first use `Set-Location` to enter the folder containing
`compose.yaml`, or pass its absolute path to `docker compose -f`. Running from
`C:\Windows\system32` without `-f` gives **no configuration file provided: not found**.

To use manual commands in the project directory:

```powershell
$env:ABDB_BIND = '127.0.0.1'
$env:ABDB_LOCAL_ONLY = '1'
$env:COOKIE_SECURE = '0'
docker compose up --build -d --wait
docker compose exec -T abdbadmin node --disable-warning=ExperimentalWarning server.mjs show-access
```

## 2. Connect your databases

1. Select **Add connection** in the sidebar.
2. Choose PostgreSQL, MySQL, or MariaDB. Enter the host, port, database name,
   and a database account. AbDbAdmin tests the connection before saving it.
3. New connections use TLS certificate verification. If your database uses a
   private CA, expand **Database CA certificate** and paste its PEM certificate.
4. Select the saved connection. Select a table in **Structure** to browse data, **3D schema**
   to explore foreign keys, or **SQL** to run statements if you have access.
   All database connections are marked **PRODUCTION**. Access permissions
   are managed per user and connection.

The application runs inside Docker. From its perspective, `127.0.0.1` is
the application container. To connect to another container, put both services
on the same Docker network and use the database service name. For a database
on a separate machine, enter its reachable address and allow connections
from the Docker host on the database side.

### Connect to MySQL or MariaDB through SSH

1. Select **Through SSH** at the top of the connection form, then choose
   **MySQL** or **MariaDB**.
2. Enter the SSH server address, port (usually `22`), and SSH username.
3. Choose a private OpenSSH or PuTTY `.ppk` key file or paste its contents.
   Enter its passphrase if it is encrypted. Authorize the corresponding
   public key on the SSH server. The Docker image includes PuTTYgen for
   converting PuTTY keys. For a manual installation, install PuTTYgen or
   export the key to OpenSSH before uploading it.
4. Enter the database host and port as seen from the SSH server. If the
   database runs on the same server and listens on loopback, use
   `127.0.0.1:3306`. Enter your database username and password separately.
5. Choose **Test and save**. Use a database host name that matches its
   TLS certificate.

The SSH server must allow TCP forwarding to the database. When you connect
to a new SSH endpoint, AbDbAdmin automatically displays the SSH server's
host-key fingerprint. Compare it with the value from the SSH administrator
or a trusted SSH-server console. If it matches, choose **Yes, trust this key**.
AbDbAdmin begins database authentication only after you approve the key and
the server presents the same fingerprint again.

Approving the key remembers it for that SSH host and port, even if the
database login fails. Later connections reuse it and reject unexpected key
changes. After an authorized rotation, verify the new fingerprint and
configure it in `ABDB_SSH_HOST_KEYS`, then test and save the connection.

If MySQL or MariaDB does not support TLS and is on the SSH server's
loopback address, choose **Retry over SSH without database TLS** after
the test reports that error. This keeps the SSH tunnel encrypted and
uses no separate TLS session between the SSH server and the database.
If you entered a public address for a database running on the SSH server
itself, use **Database on the SSH server: try 127.0.0.1**. The retry updates
the database host and keeps the SSH host and database port. For direct
connections and databases on a separate host, configure database TLS. SSH private keys and passphrases are stored
encrypted in the saved profile.

### Browse a database

Select a connection to expand its table list in the left sidebar and open
the table catalog on the right. On MySQL and MariaDB, the catalog includes
storage engine, collation, and row counts reported by the server.
**Total size** includes table data and indexes on MySQL, MariaDB, and
PostgreSQL. PostgreSQL totals also include TOAST storage and child
partitions where applicable. The catalog footer also shows the combined
size, counting each partition once.
Select a table on either side to browse its rows on the right. The catalog
provides filtering and selection. Its selection and refresh controls stay
at the bottom of the screen.

On the row screen, the heading identifies the selected table. Import and
export controls are grouped above the rows. Each column header shows its type,
nullability, and primary-key status. Expand **Column properties** for details
such as its default and collation. Administrators can use the pencil to
review all column properties, rename a column, edit a default value, or
change an eligible column's type, nullability, and collation. Depending on
the engine, the editor also supports comments, character sets, and
auto-increment controls. Use **Advanced SQL editing** from the pencil
for native definitions such as generated columns or custom expressions.
Double-click an editable row, or use **Edit**, to open its editor.
Both editors require a review before applying changes. The column form
lists fields vertically and shows controls that apply to the selected type.

Expand **Import and export** to see whole-table transfer options. Use the
checkboxes to copy or export the displayed values of selected rows. With
write access, you can set one field across selected rows, duplicate rows
with an automatically generated primary key, or delete selected rows. A
batch supports up to 50 rows on PostgreSQL and InnoDB tables. Batch
writes require a primary key and a matching snapshot for every row. If a
record has changed, the batch rolls back.

Open **3D schema** and select a table to see incoming references on the
left and outgoing references on the right. Choose a related table to
focus the map on it, or use **Open rows** to browse its data. Use **3D tilt**
to switch to a perspective view.

Browsing starts with primary-key columns in descending order. If there is no
primary key, the default uses the first supported sortable column, when
available. Set a sort explicitly in **Filters and sorting** to override it.
The row grid loads the next 50 rows as you scroll down. **Load more** is
available for manual loading or retry. Offset-based browsing can shift
when rows change while you are scrolling.

### Filter and sort rows

Open a table and expand **Filters and sorting** above the rows. Add up to eight conditions
joined with AND. **Contains** searches within the text representation of a
value and treats percent signs and underscores literally. **Equals** compares
text using the database's comparison rules. You can also filter by NULL and
choose a sort column. CSV exports use the active filters, sort, and offset.

Filter values travel as query parameters when loading rows or downloading
CSV. Configure your reverse proxy to omit query strings from logs if
filters may contain sensitive values.

### Edit a MySQL or MariaDB schema

In AbDbAdmin, select a MySQL or MariaDB connection as an administrator and
open **Schema editor**. Create, rename, or drop tables, add, rename, or drop
columns, and manage indexes and foreign keys. The editor shows the exact SQL
before applying a change and records the result in the AbDbAdmin audit log.
It uses the saved database account and is scoped to the connection's database.
The built-in editor requires no companion container.

### Import CSV, search, and inspect database objects

On a MySQL or MariaDB connection, an administrator can open an InnoDB table
and choose **Import CSV**. Use a UTF-8 comma-separated file with a header
matching the target columns, up to 200 data rows and 64 KB. The preview
shows the destination, row count, and column names. Empty fields import as
empty strings. The import uses parameterized inserts and a transaction.

**Database search** searches text fields across the visible tables, up to
five tables per request, 30 text columns per table, and five displayed
matches per table. **Database objects** shows routines, triggers, and
events visible to the connected database account.

### Run SQL scripts and restore a table

On MySQL and MariaDB, administrators can open the script editor from **Export and restore**, select a
UTF-8 SQL file or paste SQL, and confirm after reviewing the target and
script preview. The file limit is 1 MB. Multiple result sets are displayed
within the response limits. Client commands such as DELIMITER are outside
this workflow. Statements execute with the saved database account's
privileges and can target other databases that account can access. Errors
can leave earlier changes applied.

Use **Export SQL** in a base table's **Browse** view for a single-table
schema and data export, up to 1,000 rows and 1 MB. Restore it through
the script editor in the intended database. Referenced tables must already
exist where required. The export excludes triggers, routines, events,
and spatial or vector columns. Use database backup tools for full backups.

**Table maintenance** provides Check, Analyze, and Optimize. Availability
and locking depend on the database engine and table.

### Resume work from a URL

AbDbAdmin keeps the selected connection, tab, schema, table and data page
in the URL fragment. Reload or use browser Back and Forward to return to
that screen. A bookmarked route is resolved after sign-in using the
account's current permissions. SQL text, filter values, and credentials
are excluded from the URL.

### Inspect server status and object definitions

On MySQL and MariaDB, administrators can open **Server status** to view
live connection, query and traffic charts. Samples update every three seconds
and the browser keeps up to ten minutes of history per account and connection.
The **Connections and queries** table refreshes with the charts, listing up
to 100 visible sessions and a preview of their current SQL. Use **Active only**
to hide sleeping sessions. Database accounts with the global `PROCESS`
privilege can see sessions for other accounts. SQL displayed in this table
is not written to dashboard history. Server settings and the saved database
account's grants are below the table.
In **Database objects**, use **SQL definition** to view the accessible
creation statement for a routine, trigger, or event. **Open in SQL scripts**
copies the statement into an editable draft. Running it still requires a
review and confirmation.

### Export and restore multiple tables

For MySQL and MariaDB administrators, **Export and restore** generates one
SQL file with the base InnoDB tables and their rows. The export limits are
30 tables, 5,000 rows overall, 1,000 rows per table, and a 1 MB SQL file.
Views, routines, triggers, events, and database accounts are excluded.
Database exports with cross-database foreign keys or unsupported column
types are rejected. Avoid concurrent schema changes while exporting.

Choose a connection to an empty database and upload the file in
the script editor under **Export and restore**. The file contains no DROP statements and temporarily
disables foreign-key checks for the restore session so related tables can
load in any order. Use the unmodified export from a consistent source.
A failed script can leave earlier statements applied. Use native database
backup tools for production backups.

### Edit a table's definition

Open **Schema editor** and choose a table. AbDbAdmin reads types, defaults,
collations, generated expressions, and comments from the database. The editor
displays index definitions and foreign keys or constraints. The pencil opens
column actions such as rename, default value, and type or nullability where
supported. Type-specific controls allow you to enter lengths and precision.
Review the generated statement and confirm it before applying the change.

### Change a column type or table engine

In **Schema editor**, use **Change type** beside a supported column.
Review its existing type, choose a new type and nullability, and confirm
the generated SQL. Columns with special properties such as explicit
defaults, comments, generation expressions, or unsigned modifiers are
excluded from this control. The server validates data conversions.

Use **Change engine** to convert between InnoDB and MyISAM where supported.
The editor blocks conversion to MyISAM when the table has an incoming or
outgoing foreign key. Moving to MyISAM changes transaction support.

### Manage routines, triggers, and events

In **Database objects** on MySQL and MariaDB, administrators can review and
confirm a DROP statement for a procedure, function, trigger, or event. Event
forms can create a disabled recurring event, replace its SQL statement,
change its interval, and enable or disable it. Enabling an event schedules
real database work. The server account must have the necessary privileges.

Procedure, function, and trigger templates open in **SQL scripts** as
editable drafts. Replace the example names and statements before running
them. The dedicated forms do not provide a visual editor for routine or
trigger bodies. Event and object changes are recorded in the audit log.

### Review row changes

Type directly into the row editor. Typing marks the field as changed.
Use **Review changes** after editing or inserting a row. Deleting from the
row editor opens the same preview. The preview shows the connection,
schema, table, primary key when available, and before/after values. Set
**Production database** in the connection settings to highlight this target.
The write runs only after confirmation. For edits and deletes, the panel
checks whether the row has changed since it was loaded before applying the
operation. Database defaults, generated values, triggers, and cascades can
affect the final result. The preview applies to the row editor.

### Permissions

| Level | What it allows |
| --- | --- |
| View | Browse tables and views, inspect the 3D diagram, and export CSV |
| Edit rows | Everything in View, plus insert, update, and delete rows in base tables. Update and delete require a primary key. |
| Run SQL | Everything in Edit rows, plus SQL with the privileges of the saved database account |
| Administrator | All connections, users, permissions, and the audit log |

Give each saved database account only the privileges it needs. A user with
**Run SQL** can reach any database objects allowed by that account, including
objects outside the profile's main database when the database server allows it.

### Audit log

Administrators can open **Audit log** to see successful and failed panel
sign-ins, sign-outs, password changes and local resets, user and permission
changes, connection changes, CSV exports, row writes, and SQL
execution. Each event displays the time, action, outcome, and available actor
and target identifiers. Failed sign-ins omit the submitted username.

The log keeps roughly 10,000 events. Administrators can open **View SQL**
on an entry to see submitted SQL or the statements and bound values used
for a row or structure change. SQL details are encrypted in the local data
volume, use the same vault key as saved connections, and are retained for
the latest 1,000 SQL entries. Large statements are truncated. SQL, parameters, and row snapshots can contain confidential data,
including secrets typed into SQL. **Before and after** shows JSON snapshots
for captured changes to records in PostgreSQL and InnoDB tables. Inserts
and deletions use `null` for the absent row. Raw SQL and scripts show the
executed statement, because the panel does not reconstruct every affected row.
The journal marks snapshots omitted because of size limits.
Restrict access to the application administrator account and data volume.

**Undo** shows the compensating SQL and its parameters before confirmation.
It is available for eligible row updates made through the table editor on
PostgreSQL and InnoDB. It requires a primary key, matching row snapshots,
and table metadata compatible with the update. A batch rolls back entirely
if any row no longer matches. Arbitrary SQL, SQL scripts, schema changes,
inserts and deletes have no automatic undo. Use database backups or native
recovery tools when those operations need to be reversed.

The journal is intended for operational review. Someone with access to the
local data volume can alter it, and a local audit write error can leave a
gap after a database operation completes.

## Advanced MySQL and MariaDB administration

Enable the optional official phpMyAdmin container when you need server or
schema administration:

```powershell
& .\install.ps1 -Advanced
```

```sh
sh install.sh --local --advanced
```

Open [http://127.0.0.1:8100](http://127.0.0.1:8100) and sign in with a database account. Enter its server address as seen from Docker. The companion uses its
own session and the database server's permissions. AbDbAdmin credentials,
saved connection secrets, permission settings and audit history are separate.
The companion is for MySQL and MariaDB. Use a PostgreSQL-native tool for
equivalent PostgreSQL administration.

| Task | Where to start in phpMyAdmin |
| --- | --- |
| CSV and SQL imports or dump restoration | **Import** on the target database or table |
| SQL dumps and exports in other formats | **Export**, then **Custom** to choose databases, structure and data |
| Batch scripts and stored-procedure results | **SQL** or import a SQL file |
| Create and edit tables, columns, indexes and foreign keys | **Structure**, **Operations**, and **Relation view** |
| Visual schema layout | **Designer** in the database menu. Configure [phpMyAdmin configuration storage](https://docs.phpmyadmin.net/en/latest/setup.html#phpmyadmin-configuration-storage) for its advanced layout features. |
| Database users and privileges | **User accounts** and **Privileges** |
| Procedures, triggers and scheduled events | **Routines**, **Triggers**, and **Events** |
| Global search and maintenance | **Search**, **Status**, and **Operations** |

Available controls depend on the server version and database privileges.
The upload limit is 64 MB by default and can be adjusted with
`ABDB_ADVANCED_UPLOAD_LIMIT`. Set `ABDB_ADVANCED_PORT` if port 8100 is in use.
The port is published on loopback. Keep it off public reverse proxies.
To stop the companion without stopping AbDbAdmin:

```sh
docker compose --profile advanced stop phpmyadmin
```

## 3. Start on a Linux server

Install Git, Docker Engine 28 or newer, and Docker Compose V2 on the server.
Sign in over SSH as a user who can run Docker. Run these commands on the
server:

```sh
git --version &&
docker version &&
docker compose version &&
cd "$HOME" &&
git clone https://github.com/absteny/AbDbAdmin.git &&
cd AbDbAdmin &&
sh install.sh --local
```

The installer builds and starts the container and prints the initial panel
credentials. From your own computer, replace `user@server` with your SSH
login and keep this terminal open:

```sh
ssh -N -L 127.0.0.1:8099:127.0.0.1:8099 user@server
```

Open [http://127.0.0.1:8099](http://127.0.0.1:8099) on your computer. If port
8099 is already in use on your computer, replace the first 8099 in the SSH
command with 8109 and open [http://127.0.0.1:8109](http://127.0.0.1:8109).

### Serve the panel on a domain over HTTPS

Point your domain at the server and configure an HTTPS reverse proxy on the
Docker host. [Caddyfile.example](Caddyfile.example) contains a configuration
for Caddy. Replace `db.example.com` in both entries and enable that
configuration. With the same checkout, run the following on the server:

```sh
cd "$HOME/AbDbAdmin" &&
ABDB_BIND=127.0.0.1 ABDB_LOCAL_ONLY=0 ABDB_PORT=8099 \
  ABDB_DOMAIN=db.example.com COOKIE_SECURE=1 sh install.sh
```

Replace `db.example.com` with your domain each time you run the command, or
store these settings in `.env`. Open `https://db.example.com`. Use the
gateway credentials for Basic Auth, then the panel credentials to sign in.
The example also redirects HTTP on port 8080 to HTTPS when that port is
reachable.

If you deliberately publish the port on a private network interface,
set `ABDB_BIND` to that interface, restrict it with a firewall, and use
an encrypted transport for sign-in. `ABDB_IP` and `ABDB_DOMAIN` only set
the addresses printed by the installer.

## 4. Operate and update

| Task | Command |
| --- | --- |
| Start or apply an update in local-only mode | `sh install.sh --local` |
| Show access details for the running instance | `sh install.sh --show-access` |
| Stop without deleting settings | `docker compose down` |
| Rotate the shared Basic Auth password | `docker compose exec -T abdbadmin node server.mjs reset-basic` |
| Reset the administrator password and revoke its sessions | `docker compose exec -T abdbadmin node server.mjs reset-admin` |

After a reset, run `sh install.sh --show-access` from a private terminal.
Installer output contains credentials. Avoid sharing it or recording it in
public logs. Signing out ends the panel session. The browser can still cache
Basic Auth credentials. Remove a departing user's panel account and rotate
the gateway password when needed.

Back up the entire `claydb-data` volume with the container stopped. It holds
the local settings database, audit log, and the encryption key. Keep the
volume and its backups private. `docker compose down -v` deletes the volume.

If updating from the older ClayDB package, reuse its Compose project name to
keep the same volume, for example `COMPOSE_PROJECT_NAME=claydb sh install.sh --local`.
Stop the former instance first.

## Limits and development

The 3D schema displays up to 120 database objects. The data grid loads 50 rows at a time. A CSV export contains up to 500 rows from the
current offset. SQL returns up to 200 rows from the first result set. Long
values are abbreviated and binary values are represented by size. Use native
database tools for full exports or backups.

The console uses one statement and one database session per request.
Multi-step transactions across requests are unavailable. For MySQL and
MariaDB, the console supports statements allowed in prepared statements.

For development, install Node.js 24 or later:

```sh
npm ci
npm start
npm test
```

Local development data goes to `./data` unless `DATA_DIR` is set. Run
integration tests only on a disposable database. They change the tables
`clay_parent` and `clay_child`. CI covers all three supported database engines
and builds and starts the Docker image.

## Licensing and security

See [LICENSE](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.txt),
[licensing and data handling](LEGAL.md), and [security reporting](SECURITY.md).
