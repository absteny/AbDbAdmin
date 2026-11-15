# AbDbAdmin

A self-hosted administration panel for PostgreSQL, MySQL, and MariaDB. Browse
and edit tables, run SQL, and explore foreign keys in an interactive 3D schema.
Manage database access per user and review administrative activity in the audit log.

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

## 2. Try the demo before connecting a real database

Sign in as the administrator, open **Demo**, and select **Enable the demo**.
The **Sample Store** connection uses a built-in, read-only database with
synthetic customers, products, orders, and order items. It needs no database
server, credentials, or network connection.

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Give a teammate read-only access | From **Demo**, select **Open users**. Create a practice user with a new password. Open the user's **Access**, set **Sample Store** to **View**, and save. Sign out of the panel and sign back in as the practice user. | **Sample Store** is visible. You can browse its rows and diagram. SQL and row-editing controls are unavailable. |
| Find related tables in 3D | Sign back in as **admin**. In **Demo**, select **Open the 3D schema**. Find **orders** and **customers**, then open **orders** by selecting its block or using the table selector. | The diagram links **orders** to **customers**. The value of **orders.customer_id** matches **customers.id**. For example, order **101** belongs to customer **1**. |

Use **Remove the demo** to delete the sample connection and its grants.
Remove the practice user separately in **Users and permissions**.

## 3. Connect your databases

1. Select **Add connection** in the sidebar.
2. Choose PostgreSQL, MySQL, or MariaDB. Enter the host, port, database name,
   and a database account. AbDbAdmin tests the connection before saving it.
3. Keep TLS certificate verification enabled. If your database uses a private
   CA, paste its certificate in PEM format into the CA field.
4. Select the saved connection. Use **Tables** to browse data, **3D schema**
   to explore foreign keys, or **SQL** to run statements if you have access.

The application runs inside Docker. From its perspective, `127.0.0.1` is
the application container. To connect to another container, put both services
on the same Docker network and use the database service name. For a database
on a separate machine, enter its reachable address and allow connections
from the Docker host on the database side.

### Browse a database

Select a connection to expand its table list in the left sidebar and open
the table catalog on the right. On MySQL and MariaDB, the catalog includes
storage engine, collation, size, and row counts reported by the server.
Select a table on either side to browse its rows on the right.

Browsing starts with primary-key columns in descending order. If there is no
primary key, the default uses the first supported sortable column, when
available. Set a sort explicitly in **Filters and sorting** to override it.
The row grid loads the next 50 rows as you scroll down. **Load more** is
available for manual loading or retry. Offset-based browsing can shift
when rows change while you are scrolling.

### Filter rows and save a view

Open a table and select **Filters and sorting**. Add up to eight conditions
joined with AND. **Contains** searches within the text representation of a
value and treats percent signs and underscores literally. **Equals** compares
text using the database's comparison rules. You can also filter by NULL and
choose a sort column. CSV exports use the active filters, sort, and offset.

Open **Saved views**, enter a name, and save the current filters and sort.
Views belong to your account and the selected connection and table. Saving
the same name replaces the existing view. Filter values travel as URL query
parameters when loading rows or downloading CSV. Avoid logging query strings
at your reverse proxy if filters may contain sensitive values.

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

On MySQL and MariaDB, administrators can open **SQL scripts**, select a
UTF-8 SQL file or paste SQL, and confirm after reviewing the target and
script preview. The file limit is 1 MB. Multiple result sets are displayed
within the response limits. Client commands such as DELIMITER are outside
this workflow. Statements execute with the saved database account's
privileges and can target other databases that account can access. Errors
can leave earlier changes applied.

Use **Export SQL** in a base table's **Browse** view for a single-table
schema and data export, up to 1,000 rows and 1 MB. Restore it through
**SQL scripts** in the intended database. Referenced tables must already
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
selected global counters, settings, and the saved database account's grants.
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
**SQL scripts**. The file contains no DROP statements and temporarily
disables foreign-key checks for the restore session so related tables can
load in any order. Use the unmodified export from a consistent source.
A failed script can leave earlier statements applied. Use native database
backup tools for production backups.

### Manage MySQL and MariaDB accounts

As an AbDbAdmin administrator, select a MySQL or MariaDB connection and open
**Database users**. The editor lists server accounts and direct grants on
the selected database. It supports account creation, password rotation, drop,
and granting or revoking the listed privileges. Review and confirm every
change. Passwords are excluded from previews and the AbDbAdmin audit log.
Account creation and deletion affect the database server. The grant and
revoke controls apply to the saved database, and reject database names
containing wildcard characters or a backslash.

The saved database account needs permission to read the relevant columns of
`mysql.user` and `mysql.db`, and sufficient privileges for each requested
operation. The grant list excludes inherited roles, global grants, and
table-level grants. The editor prevents deleting or changing the password
of the account used by the current connection.

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
| Administrator | All connections, users, permissions, the audit log, and demo setup |

Give each saved database account only the privileges it needs. A user with
**Run SQL** can reach any database objects allowed by that account, including
objects outside the profile's main database when the database server allows it.

### Audit log

Administrators can open **Audit log** to see successful and failed panel
sign-ins, sign-outs, password changes and local resets, user and permission
changes, connection changes, demo activation, CSV exports, row writes, and SQL
execution. Each event displays the time, action, outcome, and available actor
and target identifiers. Failed sign-ins omit the submitted username.

The log stores event metadata in the local settings database. It excludes
passwords, session tokens, profile secrets, raw SQL, and row values. It keeps
roughly the latest 10,000 events. The log is intended for operational review.
It can be altered by someone with access to the local data volume, and an
audit storage error can leave a gap after a database operation completes.

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

## 4. Optional remote access

Skip this section if you want the application on `127.0.0.1` only.

**For a server you manage over SSH**, start the app on the server using
`sh install.sh --local`. From your own computer, forward the port:

```sh
ssh -N -L 8099:127.0.0.1:8099 user@server
```

Open [http://127.0.0.1:8099](http://127.0.0.1:8099) on your computer.

**For a team using a domain**, copy `.env.example` to `.env`. Set
`ABDB_DOMAIN` to your DNS name and `COOKIE_SECURE=1`. Leave `ABDB_BIND`
set to `127.0.0.1`, start with `sh install.sh` (without `--local`), and
configure an HTTPS reverse proxy on the Docker host. Replace `db.example.com`
in [Caddyfile.example](Caddyfile.example) with your domain. Point DNS at the
server and open the ports required by your proxy. The example redirects
`http://{domain}:8080` to `https://{domain}`. Enter credentials on the HTTPS
address. Basic Auth credentials can be intercepted over plain HTTP.

If you deliberately publish the port on a private network interface,
set `ABDB_BIND` to that interface, restrict it with a firewall, and use
an encrypted transport for sign-in. `ABDB_IP` and `ABDB_DOMAIN` only set
the addresses printed by the installer.

## 5. Operate and update

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
