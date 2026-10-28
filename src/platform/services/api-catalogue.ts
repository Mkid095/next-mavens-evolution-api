/**
 * The catalogue of every endpoint the platform exposes.
 *
 * The route list is NOT written by hand here — the paths come from the
 * live Express router, so a route that exists is a route that is
 * documented, and a route that is documented exists. What IS written by
 * hand is everything a reader needs: what the endpoint is for, how it is
 * authenticated, what it takes and what it answers.
 *
 * The shape of one entry:
 *
 *   method        the HTTP method
 *   path          the full path, without the /api/v1 prefix
 *   summary       one line, shown in the table
 *   description   what it does, in a sentence or two
 *   auth          how a caller authenticates
 *   parameters    the path and query parameters
 *   body          the request body, when it has one
 *   responses     what it answers with
 *   docs          the documentation page that covers it
 */

export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  type: string;
  required: boolean;
  description: string;
}

export interface ApiBodyField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiResponse {
  status: string;
  description: string;
}

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description: string;
  /** How a caller authenticates. */
  auth: string;
  parameters?: ApiParameter[];
  body?: ApiBodyField[];
  responses?: ApiResponse[];
  /** The documentation page that covers this endpoint. */
  docs?: string;
}

/** The prefix every route is mounted under. */
export const API_PREFIX = '/api/v1';

/**
 * Every endpoint, ordered by path and then by method.
 *
 * The order is the one the router mounts them in, so the table reads
 * the same way the code does.
 */
export const API_CATALOGUE: ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/accounts/',
    summary: 'List the accounts the credential belongs to',
    description:
      'Returns the authenticated account as a one-element list, with its status and plan. A credential never sees another account.',
    auth: 'API key',
    responses: [
      { status: '200', description: 'The account list' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '500', description: 'The account could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/accounts/',
    summary: 'Create an account with its first user and API key',
    description:
      'Provisions a new account, an OWNER user and a wildcard-scoped API key. The plaintext key is returned once, in the response. Only an OWNER or ADMIN session, or a wildcard-scoped key, may call this.',
    auth: 'API key',
    body: [
      { name: 'email', type: 'string', required: true, description: 'Email of the OWNER user' },
      { name: 'password', type: 'string', required: true, description: 'Password of the OWNER user' },
      { name: 'name', type: 'string', required: true, description: 'Name of the account' },
    ],
    responses: [
      { status: '201', description: 'The account, its first user and the plaintext API key' },
      { status: '400', description: 'A required field was missing' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The caller is not an account admin' },
      { status: '500', description: 'The account could not be created' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/api-keys',
    summary: 'List the account personal access tokens',
    description:
      'Lists the account-level tokens — the keys that are not tied to a project and can act on any project of the account. The key hash and the plaintext are never returned.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The token list, with the key prefix but never the key itself' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '500', description: 'The tokens could not be read' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/api-keys',
    summary: 'Create an account-level personal access token',
    description:
      'Creates a token that manages every project of the account. The plaintext key is returned once, in the response, and is never shown again. An unknown scope is refused; the wildcard scope (*) needs an admin role.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    body: [
      {
        name: 'name',
        type: 'string',
        required: false,
        description: 'Name of the token. Defaults to "Personal access token"',
      },
      {
        name: 'scopes',
        type: 'array',
        required: false,
        description: 'The scopes the token carries. The wildcard (*) is the account administrative credential',
      },
    ],
    responses: [
      { status: '201', description: 'The token and its plaintext, shown only once' },
      { status: '400', description: 'A requested scope is not one the platform knows' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The account belongs to another tenant, or a wildcard token needs an admin' },
      { status: '500', description: 'The token could not be created' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'DELETE',
    path: '/accounts/:accountId/api-keys/:keyId',
    summary: 'Revoke an account-level personal access token',
    description:
      'Sets the revocation time on the token, so it stops working immediately. The record is kept, so the audit trail still names it.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      { name: 'keyId', in: 'path', type: 'string', required: true, description: 'The key public id (key_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The token was revoked' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'No such key on this account' },
      { status: '500', description: 'The token could not be revoked' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/api-keys/default',
    summary: 'Read the account default personal access token',
    description:
      'Returns the account default token, plaintext included. It is generated on the first read, so the response always carries a ready-to-paste credential. A key calling this needs the api_keys:read scope.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The default token, plaintext included' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The account belongs to another tenant, or the scope is missing' },
      { status: '404', description: 'No account with that id' },
      { status: '500', description: 'The token could not be read' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/api-keys/default/rotate',
    summary: 'Rotate the account default personal access token',
    description:
      'Issues a new default token and revokes the previous one, so the old token stops working the moment this returns. A key calling this needs the api_keys:write scope.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The new default token, plaintext included' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The account belongs to another tenant, or the scope is missing' },
      { status: '404', description: 'No account with that id' },
      { status: '500', description: 'The token could not be rotated' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects',
    summary: 'List the projects of an account',
    description:
      'Returns the projects of the account with their status. The account id in the URL must match the account of the caller.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The project list' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '500', description: 'The projects could not be read' },
    ],
    docs: 'projects',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects',
    summary: 'Create a project',
    description:
      'Creates a project inside the account. A project is the unit of ownership: its instances, keys, webhooks and logs live in it.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    body: [
      { name: 'name', type: 'string', required: true, description: 'Name of the project, at least two characters' },
      { name: 'description', type: 'string', required: false, description: 'What the project is for' },
    ],
    responses: [
      { status: '201', description: 'The new project' },
      { status: '400', description: 'The name was missing or too short' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '500', description: 'The project could not be created' },
    ],
    docs: 'projects',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId',
    summary: 'Read one project',
    description: 'Returns the project named by its public id, with its slug, description and status.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The project' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The project could not be read' },
    ],
    docs: 'projects',
  },
  {
    method: 'PATCH',
    path: '/accounts/:accountId/projects/:projectPublicId',
    summary: 'Rename a project or change its description',
    description: 'Updates the name and the description of a project. Both fields are optional; send only what changes.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    body: [
      { name: 'name', type: 'string', required: false, description: 'The new name of the project' },
      { name: 'description', type: 'string', required: false, description: 'The new description of the project' },
    ],
    responses: [
      { status: '200', description: 'The updated project' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The project could not be updated' },
    ],
    docs: 'projects',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys',
    summary: 'List the API keys of a project',
    description:
      'Lists the keys of the project with their scopes, key prefix and last use. The hash and the plaintext never leave the server.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The key list' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The keys could not be read' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys',
    summary: 'Create an API key in a project',
    description:
      'Creates a key scoped to the project. The plaintext key is returned once, in the response. An unknown scope is refused; the wildcard scope (*) needs an admin role.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    body: [
      { name: 'name', type: 'string', required: false, description: 'Name of the key' },
      {
        name: 'scopes',
        type: 'array',
        required: false,
        description: 'The scopes the key carries. The wildcard (*) is the account administrative credential',
      },
    ],
    responses: [
      { status: '201', description: 'The key and its plaintext, shown only once' },
      { status: '400', description: 'A requested scope is not one the platform knows' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller, or a wildcard key needs an admin' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The key could not be created' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'DELETE',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys/:keyId',
    summary: 'Revoke a project API key',
    description:
      'Sets the revocation time on the key, so it stops working immediately. The record is kept, so the audit trail still names it.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'keyId', in: 'path', type: 'string', required: true, description: 'The key public id (key_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The key was revoked' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such key on this project' },
      { status: '500', description: 'The key could not be revoked' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys/:keyId/instances/:instId/bind',
    summary: 'Bind an API key to an instance',
    description:
      'Restricts the key to the named instance: a key with bindings may only act on the instances it is bound to. Binding the same pair twice answers 409.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'keyId', in: 'path', type: 'string', required: true, description: 'The key public id (key_xxx)' },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '201', description: 'The binding was created' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such key or instance on this project' },
      { status: '409', description: 'The key is already bound to that instance' },
      { status: '500', description: 'The binding could not be created' },
    ],
    docs: 'instances',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys/default',
    summary: 'Read the project default token',
    description:
      'Returns the default token of the project, plaintext included. It is generated on the first read, so the response always carries a ready-to-paste credential. A key calling this needs the api_keys:read scope.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The default token, plaintext included' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller, or the scope is missing' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The token could not be read' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/api-keys/default/rotate',
    summary: 'Rotate the project default token',
    description:
      'Issues a new default token and revokes the previous one, so the old token stops working the moment this returns. A key calling this needs the api_keys:write scope.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The new default token, plaintext included' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller, or the scope is missing' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The token could not be rotated' },
    ],
    docs: 'api-keys',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/archive',
    summary: 'Archive a project',
    description:
      'Marks the project archived. Its instances, keys and webhooks stop being usable; the audit history is kept.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The project was archived' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The project could not be archived' },
    ],
    docs: 'projects',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/contacts',
    summary: 'List the contacts of a project',
    description:
      'Returns the contacts the platform holds for the project, with their JID and LID. It reflects the last sync, not the live WhatsApp address book.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The contact list' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The contacts could not be read' },
    ],
    docs: 'contacts-groups',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/groups',
    summary: 'List the groups of a project',
    description:
      'Returns the groups the platform holds for the project, with their participant counts. The engine references behind them are not exposed.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The group list' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The groups could not be read' },
    ],
    docs: 'contacts-groups',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/instances',
    summary: 'List the instances of a project',
    description:
      'Returns the instances of the project, reconciled against the live socket first, so the statuses are current rather than a stored copy.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The instance list' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The instances could not be read' },
    ],
    docs: 'instances',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances',
    summary: 'Create an instance in a project',
    description:
      'Creates the WhatsApp session and the engine row behind it. The instance name is unique per account: a repeat returns the existing instance with 200, and a name taken in another project answers 409. The new instance starts disconnected.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    body: [{ name: 'name', type: 'string', required: true, description: 'Name of the instance, unique per account' }],
    responses: [
      { status: '201', description: 'The new instance' },
      { status: '200', description: 'An instance with that name already existed in this project' },
      { status: '400', description: 'The name was missing' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '409', description: 'The name is taken by an instance in another project' },
      { status: '500', description: 'The instance could not be created' },
    ],
    docs: 'instances',
  },
  {
    method: 'DELETE',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId',
    summary: 'Delete an instance',
    description:
      'Disconnects the session, removes it from the engine and deletes the platform record. The pairing is gone with it, so the instance has to be paired again.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The instance was deleted' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The instance could not be deleted' },
    ],
    docs: 'instances',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId',
    summary: 'Read one instance and its pairing QR code',
    description:
      'Returns the instance, with the pairing QR code and the pairing code when the engine has produced one. The same QR arrives on the instance event stream.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The instance, with a QR code when one exists' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The instance could not be read' },
    ],
    docs: 'instances',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/connect',
    summary: 'Connect an instance to WhatsApp',
    description:
      'Starts the pairing. The response carries no QR code: the pairing QR arrives on the instance event stream, or from the instance read once the engine has produced it.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The connection was started; the status is CONNECTING' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The instance could not be connected' },
    ],
    docs: 'instances',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/contacts/sync',
    summary: 'Sync the contacts of an instance',
    description:
      'Reads the address book from the engine and upserts each contact into the project. The response reports how many contacts were synced.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The number of contacts synced' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The contacts could not be synced' },
    ],
    docs: 'contacts-groups',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/disconnect',
    summary: 'Disconnect an instance from WhatsApp',
    description: 'Drops the WhatsApp connection but keeps the instance and its pairing.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The instance was disconnected' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The instance could not be disconnected' },
    ],
    docs: 'instances',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/groups/sync',
    summary: 'Sync the groups of an instance',
    description:
      'Reads the groups from the engine and upserts them into the project. Groups already known are updated, new ones are added. The response reports how many were synced.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The number of groups synced' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The groups could not be synced' },
    ],
    docs: 'contacts-groups',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/profile-picture',
    summary: 'Fetch the WhatsApp profile picture of an instance',
    description:
      'Proxies the image bytes rather than handing over a URL: the WhatsApp picture URLs are signed and expire, so a URL would silently stop rendering. The response is cached privately for an hour.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The image bytes' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance, or it has no profile picture' },
      { status: '500', description: 'The picture could not be fetched' },
    ],
    docs: 'instances',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/restart',
    summary: 'Restart the session of an instance',
    description: 'Restarts the WhatsApp session of the instance and reconnects it.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The instance was restarted; the status is RESTARTING' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The instance could not be restarted' },
    ],
    docs: 'instances',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/instances/:instId/state',
    summary: 'Read the canonical state of an instance',
    description:
      'Returns the live state — CONNECTED, CONNECTING, CREATED, DISCONNECTED or SUSPENDED — with the phone number and the capabilities. Never a JID or an engine reference.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      {
        name: 'instId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The state of the instance' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such instance on this project' },
      { status: '500', description: 'The state could not be read' },
    ],
    docs: 'instances',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/logs',
    summary: 'Read the activity log of a project',
    description:
      'Returns a page of log events — api, mcp, auth or message — newest first, with the cursor for the next page.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'category', in: 'query', type: 'string', required: false, description: 'api, mcp, auth or message' },
      {
        name: 'limit',
        in: 'query',
        type: 'number',
        required: false,
        description: 'Page size. 50 by default, 200 at most',
      },
      {
        name: 'cursor',
        in: 'query',
        type: 'string',
        required: false,
        description: 'The nextCursor of the previous page',
      },
    ],
    responses: [
      { status: '200', description: 'The page of events and the cursor for the next one' },
      { status: '400', description: 'The category is not one the platform knows' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The log could not be read' },
    ],
    docs: 'logs',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/logs/:logId',
    summary: 'Read one log event',
    description:
      'Returns the event in full. The lookup is scoped to the project, so an event belonging to another project is simply not found.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'logId', in: 'path', type: 'string', required: true, description: 'The id of the event' },
    ],
    responses: [
      { status: '200', description: 'The event' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such event on this project' },
      { status: '500', description: 'The event could not be read' },
    ],
    docs: 'logs',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/projects/:projectPublicId/webhooks',
    summary: 'List the webhooks of a project',
    description:
      'Returns the webhooks of the project. The instance id in the answer is the public one (inst_xxx), not the internal row id.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    responses: [
      { status: '200', description: 'The webhook list' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The webhooks could not be read' },
    ],
    docs: 'webhooks',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/webhooks',
    summary: 'Register a webhook for an instance',
    description:
      'The instance id is the public one (inst_xxx). The response carries the plaintext signing secret, which is shown only at creation: it is stored encrypted and can never be read back, so save it now.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
    ],
    body: [
      {
        name: 'instanceId',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx) the webhook belongs to',
      },
      { name: 'url', type: 'string', required: true, description: 'The HTTPS endpoint the payloads are posted to' },
      {
        name: 'events',
        type: 'array',
        required: false,
        description: 'The event types to deliver. Empty means every event',
      },
    ],
    responses: [
      { status: '201', description: 'The webhook and its plaintext secret, shown only once' },
      { status: '400', description: 'The instance id or the url was missing, or the instance is not on this project' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The webhook could not be created' },
    ],
    docs: 'webhooks',
  },
  {
    method: 'DELETE',
    path: '/accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId',
    summary: 'Delete a webhook',
    description: 'Removes the webhook. No more payloads are delivered to it.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'webhookId', in: 'path', type: 'string', required: true, description: 'The webhook public id (wh_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The webhook was deleted' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such webhook on this project' },
      { status: '500', description: 'The webhook could not be deleted' },
    ],
    docs: 'webhooks',
  },
  {
    method: 'PATCH',
    path: '/accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId',
    summary: 'Update a webhook',
    description:
      'Changes the url, the event list or the enabled flag of a webhook. Every field is optional; send only what changes.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'webhookId', in: 'path', type: 'string', required: true, description: 'The webhook public id (wh_xxx)' },
    ],
    body: [
      { name: 'url', type: 'string', required: false, description: 'The new endpoint' },
      { name: 'events', type: 'array', required: false, description: 'The new list of event types to deliver' },
      { name: 'enabled', type: 'boolean', required: false, description: 'Whether deliveries are made at all' },
    ],
    responses: [
      { status: '200', description: 'The webhook was updated' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such webhook on this project' },
      { status: '500', description: 'The webhook could not be updated' },
    ],
    docs: 'webhooks',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/projects/:projectPublicId/webhooks/:webhookId/rotate',
    summary: 'Rotate the signing secret of a webhook',
    description:
      'Issues a new secret and returns the plaintext, which is shown only at rotation time. The old secret stops verifying immediately.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
      {
        name: 'projectPublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The project public id (proj_xxx) or its slug',
      },
      { name: 'webhookId', in: 'path', type: 'string', required: true, description: 'The webhook public id (wh_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The new secret, plaintext, shown only once' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The project does not belong to the caller' },
      { status: '404', description: 'No such webhook on this project' },
      { status: '500', description: 'The secret could not be rotated' },
    ],
    docs: 'webhooks',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/subscription',
    summary: 'Read the account subscription',
    description:
      'Returns the active subscription of the account and the plan it is on. The account id in the URL must be the account of the caller.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The subscription' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'The account has no active subscription' },
      { status: '500', description: 'The subscription could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/accounts/:accountId/users',
    summary: 'List the users of an account',
    description:
      'Lists the dashboard users of the account with their role and last login. The account id in the URL must match the account of the caller.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The user list' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '500', description: 'The users could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/accounts/:accountId/users',
    summary: 'Add a user to an account',
    description:
      'Creates a dashboard user. The user has no password yet — they set one through the password reset flow. The role defaults to MEMBER.',
    auth: 'API key',
    parameters: [
      {
        name: 'accountId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The account public id (acct_xxx)',
      },
    ],
    body: [
      { name: 'email', type: 'string', required: true, description: 'Email of the new user' },
      { name: 'name', type: 'string', required: false, description: 'Display name of the new user' },
      { name: 'role', type: 'string', required: false, description: 'OWNER, ADMIN or MEMBER. Defaults to MEMBER' },
    ],
    responses: [
      { status: '201', description: 'The new user' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '500', description: 'The user could not be created' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/accounts/:id/suspend',
    summary: 'Suspend an account',
    description:
      'Suspends the account named by :id, which may be a public id or an internal account id. Suspending your own account needs an admin role; suspending a different account needs an admin role and the company password in the body.',
    auth: 'API key',
    parameters: [
      {
        name: 'id',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The public id (acct_xxx) or internal id of the account to suspend',
      },
    ],
    body: [
      { name: 'reason', type: 'string', required: false, description: 'Why the account is being suspended' },
      {
        name: 'companyPassword',
        type: 'string',
        required: false,
        description: 'Required to suspend an account other than your own',
      },
    ],
    responses: [
      { status: '200', description: 'The account was suspended' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'Not an admin, or the company password was missing or wrong' },
      { status: '404', description: 'No account with that id' },
      { status: '500', description: 'The account could not be suspended' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/accounts/:publicId',
    summary: 'Read one account by its public id',
    description:
      'Returns the account named by the public id. A credential that does not own the account gets 403 rather than the account.',
    auth: 'API key',
    parameters: [
      { name: 'publicId', in: 'path', type: 'string', required: true, description: 'The account public id (acct_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The account' },
      { status: '401', description: 'Missing or invalid API key' },
      { status: '403', description: 'The account belongs to another tenant' },
      { status: '404', description: 'No account with that public id' },
      { status: '500', description: 'The account could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/instances/:id/messages/send',
    summary: 'Queue a message through an instance',
    description:
      'Queues a durable message command and answers 202 with the public message id. The message is not delivered by this call — the outbox worker paces and sends it. The :id is the internal instance id, not the public one.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'id',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The internal instance id of the platform instance',
      },
    ],
    body: [
      { name: 'number', type: 'string', required: true, description: 'The recipient number, in international format' },
      { name: 'text', type: 'string', required: true, description: 'The body of the message' },
      { name: 'type', type: 'string', required: false, description: 'The kind of message. Defaults to text' },
    ],
    responses: [
      { status: '202', description: 'The message was queued; the message id is returned' },
      { status: '400', description: 'The number or the text was missing' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The key is scoped to a different project' },
      { status: '404', description: 'No such instance, or the engine row is missing' },
      { status: '500', description: 'The message could not be queued' },
    ],
    docs: 'messages',
  },
  {
    method: 'GET',
    path: '/me',
    summary: 'Read the account, plan and project this credential belongs to',
    description:
      'The tenant behind the credential: the account, its status, its plan, and the project the credential is scoped to. A project key names its own project; a dashboard session falls back to the account’s default project. The CLI uses this to discover which project to call the project-scoped routes with.',
    auth: 'API key or session cookie',
    responses: [
      { status: '200', description: 'The account, plan and project' },
      { status: '401', description: 'No credential, or an invalid one' },
    ],
    docs: 'authentication',
  },
  {
    method: 'GET',
    path: '/messages/',
    summary: 'List the messages of the account, newest first',
    description:
      'Returns a page of messages with their state and their delivery receipt, and the cursor for the next page.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'instancePublicId',
        in: 'query',
        type: 'string',
        required: false,
        description: 'Only messages sent through this instance (inst_xxx)',
      },
      {
        name: 'state',
        in: 'query',
        type: 'string',
        required: false,
        description: 'queued, processing, sent, failed or skipped',
      },
      {
        name: 'since',
        in: 'query',
        type: 'string',
        required: false,
        description: 'ISO timestamp: anything created at or after it',
      },
      {
        name: 'limit',
        in: 'query',
        type: 'number',
        required: false,
        description: 'Page size. 50 by default, 200 at most',
      },
      {
        name: 'cursor',
        in: 'query',
        type: 'string',
        required: false,
        description: 'The nextCursor of the previous page',
      },
    ],
    responses: [
      { status: '200', description: 'The page of messages and the cursor for the next one' },
      { status: '400', description: 'The state or the since timestamp was not understood' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '500', description: 'The messages could not be read' },
    ],
    docs: 'messages',
  },
  {
    method: 'GET',
    path: '/messages/:messageId',
    summary: 'Read the state of one message',
    description:
      'Returns the message with the id the send route returned: its state (queued, processing, sent, failed or skipped), the attempts, the last error and the delivery receipt.',
    auth: 'API key or session cookie',
    parameters: [
      { name: 'messageId', in: 'path', type: 'string', required: true, description: 'The public message id (msg_xxx)' },
    ],
    responses: [
      { status: '200', description: 'The message' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '404', description: 'No such message on this account' },
      { status: '500', description: 'The message could not be read' },
    ],
    docs: 'messages',
  },
  {
    method: 'POST',
    path: '/messages/check-numbers',
    summary: 'Check which numbers are on WhatsApp',
    description:
      'Asks WhatsApp which of the given numbers have an account. WhatsApp accepts a message to a number that has none and never delivers it, so a broadcast checks first. At most 500 numbers per call.',
    auth: 'API key or session cookie',
    body: [
      {
        name: 'instancePublicId',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx) the check goes out through',
      },
      { name: 'numbers', type: 'array', required: true, description: 'The numbers to check, at most 500 of them' },
    ],
    responses: [
      { status: '200', description: 'The result for each number, and how many are on WhatsApp' },
      { status: '400', description: 'The instance id or the numbers were missing, or there were too many' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The key is scoped to a different project' },
      { status: '404', description: 'No such instance on this account' },
      { status: '500', description: 'The check could not be made' },
    ],
    docs: 'messages',
  },
  {
    method: 'POST',
    path: '/messages/send',
    summary: 'Send a message through an instance',
    description:
      'The canonical send route. It queues the message and answers 202 with the public message id — the message is not delivered yet, and the outbox paces the sends. Accepts text, image, video, document and audio; a type the platform does not transmit is refused with 400.',
    auth: 'API key or session cookie',
    body: [
      {
        name: 'instancePublicId',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx) the message goes out through',
      },
      { name: 'number', type: 'string', required: true, description: 'The recipient number, in international format' },
      {
        name: 'type',
        type: 'string',
        required: false,
        description: 'text, image, video, document or audio. Defaults to text',
      },
      {
        name: 'text',
        type: 'string',
        required: false,
        description: 'The body of a text message, or the caption of a media one',
      },
      {
        name: 'media',
        type: 'string',
        required: false,
        description: 'An https URL, a data: base64 URI or base64 of the file to send',
      },
      { name: 'caption', type: 'string', required: false, description: 'The caption of a media message' },
      { name: 'fileName', type: 'string', required: false, description: 'The file name of a document' },
      { name: 'mimeType', type: 'string', required: false, description: 'The MIME type of the file' },
    ],
    responses: [
      { status: '202', description: 'The message was queued; the message id is returned' },
      { status: '400', description: 'A field was missing, or the message type is not one the platform sends' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The key is scoped to a different project' },
      { status: '404', description: 'No such instance on this account' },
      { status: '429', description: 'The account rate limit was exceeded' },
      { status: '500', description: 'The message could not be queued' },
    ],
    docs: 'messages',
  },
  {
    method: 'GET',
    path: '/messages/summary',
    summary: 'Summarise how a batch of messages is doing',
    description:
      'Counts the messages by state and by delivery receipt, groups the failures by reason, and reports how many were handed to WhatsApp but never delivered.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'instancePublicId',
        in: 'query',
        type: 'string',
        required: false,
        description: 'Only messages sent through this instance (inst_xxx)',
      },
      {
        name: 'since',
        in: 'query',
        type: 'string',
        required: false,
        description: 'ISO timestamp: anything created at or after it',
      },
    ],
    responses: [
      { status: '200', description: 'The counts, the failure groups and the delivery breakdown' },
      { status: '400', description: 'The since timestamp was not an ISO date' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '500', description: 'The summary could not be read' },
    ],
    docs: 'message-lifecycle',
  },
  {
    method: 'GET',
    path: '/plans',
    summary: 'List the plans an account can subscribe to',
    description:
      'The plans the platform offers, with their limits. Public — a reader can see what is on offer before they have an account.',
    auth: 'None',
    responses: [
      { status: '200', description: 'The list of plans' },
      { status: '500', description: 'The plans could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/activity/history',
    summary: 'Read the recent audit events of the account',
    description:
      'Returns the audit events of the account, newest first, with an optional project filter and a since cursor.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'limit',
        in: 'query',
        type: 'number',
        required: false,
        description: 'How many events to return. 50 by default, 200 at most',
      },
      {
        name: 'since',
        in: 'query',
        type: 'string',
        required: false,
        description: 'ISO timestamp: only events created after it',
      },
      {
        name: 'projectPublicId',
        in: 'query',
        type: 'string',
        required: false,
        description: 'Only the events of this project',
      },
    ],
    responses: [
      { status: '200', description: 'The events' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '404', description: 'No such project on this account' },
      { status: '500', description: 'The events could not be read' },
    ],
    docs: 'activity',
  },
  {
    method: 'GET',
    path: '/platform/activity/stream',
    summary: 'Stream the audit events of the account',
    description:
      'A Server-Sent Events stream of the audit events of the account, with a heartbeat every 25 seconds. The connection stays open and carries a comment when the broker is unreachable.',
    auth: 'API key or session cookie',
    responses: [
      { status: '200', description: 'The event stream' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '500', description: 'The stream could not be opened' },
    ],
    docs: 'activity',
  },
  {
    method: 'PATCH',
    path: '/platform/auth/account',
    summary: 'Rename the account',
    description:
      'Renames the workspace and the display name of the signed-in user together, so the dashboard header stays in step.',
    auth: 'Session cookie',
    body: [
      { name: 'name', type: 'string', required: true, description: 'The new name of the account, 2 to 80 characters' },
    ],
    responses: [
      { status: '200', description: 'The new name and the email of the user' },
      { status: '400', description: 'The name was missing or out of range' },
      { status: '401', description: 'No session, or the session has expired' },
      { status: '500', description: 'The account could not be renamed' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/change-password',
    summary: 'Change the password of the signed-in user',
    description:
      'Rotates the password of the signed-in user. The current password is required as proof and the new one must be at least eight characters. Needs the X-CSRF-Token header.',
    auth: 'Session cookie',
    body: [
      { name: 'currentPassword', type: 'string', required: true, description: 'The current password of the user' },
      { name: 'newPassword', type: 'string', required: true, description: 'The new password, at least 8 characters' },
    ],
    responses: [
      { status: '200', description: 'The password was changed' },
      { status: '400', description: 'A field was missing, or the new password was too short' },
      { status: '401', description: 'No session, or the current password is wrong' },
      { status: '403', description: 'The CSRF token was missing or did not match' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/auth/csrf',
    summary: 'Get a CSRF token',
    description:
      'Returns a CSRF token and sets the matching cookie. Send the token in the X-CSRF-Token header on the routes that change state.',
    auth: 'None',
    responses: [{ status: '200', description: 'The CSRF token' }],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/forgot-password/reset',
    summary: 'Finish a password reset',
    description:
      'Sets the new password against the signed reset token from the verify step and clears the session cookie. The token is valid for fifteen minutes and is refused once it has expired.',
    auth: 'None',
    body: [
      { name: 'resetToken', type: 'string', required: true, description: 'The signed token from the verify step' },
      { name: 'newPassword', type: 'string', required: true, description: 'The new password, at least 8 characters' },
    ],
    responses: [
      { status: '200', description: 'The password was changed' },
      { status: '400', description: 'A field was missing, or the new password was too short' },
      { status: '401', description: 'The reset token is invalid or has expired' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/forgot-password/verify',
    summary: 'Start a password reset',
    description:
      'Checks the company password and the email address, then returns a signed reset token that is valid for fifteen minutes. That token is the credential for the reset step.',
    auth: 'Company gate password',
    body: [
      { name: 'email', type: 'string', required: true, description: 'The email of the account to recover' },
      { name: 'companyPassword', type: 'string', required: true, description: 'The company gate password' },
    ],
    responses: [
      { status: '200', description: 'The signed reset token and its lifetime' },
      { status: '400', description: 'The email or the company password was missing' },
      { status: '401', description: 'The company password is wrong' },
      { status: '404', description: 'No account with that email' },
      { status: '500', description: 'The reset could not be started' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/login',
    summary: 'Sign in and open a session',
    description:
      'Checks the email and the password and sets the session cookie. The answer is deliberately the same for an unknown email and a wrong password, so it cannot be used to find out who has an account.',
    auth: 'None',
    body: [
      { name: 'email', type: 'string', required: true, description: 'The email of the user' },
      { name: 'password', type: 'string', required: true, description: 'The password of the user' },
    ],
    responses: [
      { status: '200', description: 'The user and the account; the session cookie is set' },
      { status: '400', description: 'The email or the password was missing' },
      { status: '401', description: 'The email or the password is wrong' },
      { status: '500', description: 'The sign-in failed' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/logout',
    summary: 'End the session',
    description:
      'Destroys the session and clears the session and CSRF cookies. Needs the X-CSRF-Token header that matches the CSRF cookie.',
    auth: 'Session cookie',
    responses: [
      { status: '200', description: 'The session was ended' },
      { status: '401', description: 'No session, or the session has expired' },
      { status: '403', description: 'The CSRF token was missing or did not match' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/auth/me',
    summary: 'Read the signed-in user and account',
    description: 'Returns the user of the session, with their role, and the account they belong to.',
    auth: 'Session cookie',
    responses: [
      { status: '200', description: 'The user and the account' },
      { status: '401', description: 'No session, or the session has expired' },
      { status: '404', description: 'The user of the session no longer exists' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/refresh-session',
    summary: 'Extend the session',
    description:
      'Pushes the expiry of the session back. The dashboard calls this before the session lapses so the user stays signed in.',
    auth: 'Session cookie',
    responses: [
      { status: '200', description: 'The session was extended' },
      { status: '401', description: 'No session, or the session has expired' },
    ],
    docs: 'platform',
  },
  {
    method: 'POST',
    path: '/platform/auth/signup',
    summary: 'Create an account and sign in',
    description:
      'Creates the account and its OWNER user, then opens a session. The company password in the body proves the caller belongs to the organisation, so this is not an open public sign-up.',
    auth: 'Company gate password',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Name of the account, 2 to 80 characters' },
      { name: 'email', type: 'string', required: true, description: 'Email of the OWNER user' },
      {
        name: 'password',
        type: 'string',
        required: true,
        description: 'Password of the OWNER user, at least 8 characters',
      },
      { name: 'companyPassword', type: 'string', required: true, description: 'The company gate password' },
    ],
    responses: [
      { status: '201', description: 'The account and the user; the session cookie is set' },
      { status: '400', description: 'A field was missing, the name was out of range, or the password was too short' },
      { status: '401', description: 'The company password is wrong' },
      { status: '409', description: 'An account with that email already exists' },
      { status: '500', description: 'The account could not be created' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/docs/',
    summary: 'List the documentation pages',
    description:
      'Returns the documentation index grouped by section. With all=true it returns the whole documentation as one Markdown document instead.',
    auth: 'None',
    parameters: [
      {
        name: 'all',
        in: 'query',
        type: 'boolean',
        required: false,
        description: 'Pass true for the whole documentation as one Markdown document',
      },
    ],
    responses: [
      { status: '200', description: 'The index, or the whole documentation as Markdown' },
      { status: '500', description: 'The documentation could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/docs/:slug',
    summary: 'Read one documentation page',
    description:
      'Returns the page with its body rendered to Markdown. The body is fetched from the public documentation site; when that site cannot be reached the metadata is still returned, with a note saying so.',
    auth: 'None',
    parameters: [
      { name: 'slug', in: 'path', type: 'string', required: true, description: 'The page slug, e.g. messages' },
    ],
    responses: [
      { status: '200', description: 'The page, with its body in Markdown when it could be fetched' },
      { status: '404', description: 'No documentation page with that slug' },
      { status: '500', description: 'The page could not be read' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/docs/search',
    summary: 'Search the documentation',
    description:
      'Searches the page index by slug, title, description and topic and returns up to twenty-five hits, most relevant first.',
    auth: 'None',
    parameters: [{ name: 'q', in: 'query', type: 'string', required: true, description: 'What to search for' }],
    responses: [
      { status: '200', description: 'The hits and the number of them' },
      { status: '400', description: 'The query was empty' },
      { status: '500', description: 'The search could not be made' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/health',
    summary: 'Check that the platform and its database are up',
    description:
      'A liveness check that also verifies database connectivity. It answers 503 when the database cannot be reached, so a monitor can use the status code alone.',
    auth: 'None',
    responses: [
      { status: '200', description: 'The platform is healthy' },
      { status: '503', description: 'The platform or its database is not answering' },
    ],
    docs: 'platform',
  },
  {
    method: 'DELETE',
    path: '/platform/mcp/',
    summary: 'Tear down an MCP session',
    description: 'The MCP server runs statelessly, so there is no session to terminate and this always answers 405.',
    auth: 'API key or session cookie',
    responses: [
      { status: '401', description: 'Missing or invalid credential' },
      { status: '405', description: 'The server is stateless, so there is nothing to tear down' },
    ],
    docs: 'mcp-overview',
  },
  {
    method: 'GET',
    path: '/platform/mcp/',
    summary: 'Open the MCP notification stream',
    description:
      'The server-to-client half of the standard MCP transport. The server is stateless and never initiates notifications, so this is an idle event stream.',
    auth: 'API key or session cookie',
    responses: [
      { status: '200', description: 'The event stream' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '500', description: 'The stream could not be opened' },
    ],
    docs: 'mcp-overview',
  },
  {
    method: 'POST',
    path: '/platform/mcp/',
    summary: 'Talk to the platform over the standard MCP transport',
    description:
      'The endpoint a stock MCP client connects to. It speaks JSON-RPC 2.0 over Streamable HTTP: initialize, notifications/initialized, tools/list, tools/call. The tools act on one project — a project-scoped key on its own, an account-level token on the project it names in the X-Viventure-Project header.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'X-Viventure-Project',
        in: 'header',
        type: 'string',
        required: false,
        description: 'The project an account-level token acts on, by public id or slug',
      },
    ],
    body: [
      {
        name: 'jsonrpc',
        type: 'object',
        required: true,
        description: 'The JSON-RPC 2.0 request: the method, its parameters and the id',
      },
    ],
    responses: [
      { status: '200', description: 'The JSON-RPC result, or a JSON-RPC error' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '500', description: 'The transport failed' },
    ],
    docs: 'mcp-overview',
  },
  {
    method: 'GET',
    path: '/platform/mcp/events',
    summary: 'Stream the MCP tool invocations',
    description:
      'A Server-Sent Events stream of the tool invocations of the account, with a heartbeat every 25 seconds.',
    auth: 'API key or session cookie',
    responses: [
      { status: '200', description: 'The event stream' },
      { status: '401', description: 'Missing or invalid credential' },
    ],
    docs: 'mcp-discovery',
  },
  {
    method: 'GET',
    path: '/platform/mcp/events/history',
    summary: 'Read the recent MCP tool invocations',
    description:
      'Returns the last fifty invocations, newest first. It backs the live stream when the connection is not available.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'X-Viventure-Project',
        in: 'header',
        type: 'string',
        required: false,
        description: 'The project an account-level token acts on, by public id or slug',
      },
    ],
    responses: [
      { status: '200', description: 'The invocations' },
      { status: '401', description: 'Missing or invalid credential' },
    ],
    docs: 'mcp-discovery',
  },
  {
    method: 'POST',
    path: '/platform/mcp/invoke',
    summary: 'Run an MCP tool',
    description:
      'Executes the named tool with the given parameters and returns its result. A tool the key has no scope for is refused, and a project hint that names another project is an error rather than something to ignore.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'X-Viventure-Project',
        in: 'header',
        type: 'string',
        required: false,
        description: 'The project an account-level token acts on, by public id or slug',
      },
    ],
    body: [
      { name: 'tool', type: 'string', required: true, description: 'The name of the tool, e.g. send_message' },
      { name: 'parameters', type: 'object', required: false, description: 'The arguments of the tool' },
    ],
    responses: [
      { status: '200', description: 'The result of the tool, or a JSON-RPC error' },
      { status: '401', description: 'Missing or invalid credential' },
      { status: '403', description: 'The credential has no scope for that tool' },
      { status: '500', description: 'The tool failed' },
    ],
    docs: 'mcp-tools',
  },
  {
    method: 'GET',
    path: '/platform/mcp/tools',
    summary: 'List the MCP tool categories',
    description:
      'Returns the eight tool categories with the number of tools in each. The category endpoint then gives you the schemas.',
    auth: 'API key or session cookie',
    responses: [
      { status: '200', description: 'The categories' },
      { status: '401', description: 'Missing or invalid credential' },
    ],
    docs: 'mcp-discovery',
  },
  {
    method: 'GET',
    path: '/platform/mcp/tools/:category',
    summary: 'List the tools of one MCP category',
    description:
      'Returns the tool definitions of the category with their parameters and the scopes they need. An unknown category is refused with the list of valid ones.',
    auth: 'API key or session cookie',
    parameters: [
      {
        name: 'category',
        in: 'path',
        type: 'string',
        required: true,
        description:
          'The category id: instances, messages, webhooks, api_keys, account, health, contacts or documentation',
      },
    ],
    responses: [
      { status: '200', description: 'The tools of the category' },
      { status: '401', description: 'Missing or invalid credential' },
    ],
    docs: 'mcp-discovery',
  },
  {
    method: 'POST',
    path: '/platform/onboard',
    summary: 'Provision a new account with its owner user and a first API key',
    description:
      'Provisions a brand-new account, an OWNER user, a default project, a trial subscription and a wildcard API key in one call. Gated by the company password, exactly like signup — this is an internal platform, not a public sign-up. The response carries the account, the user and the plaintext API key.',
    auth: 'Company gate password',
    body: [
      { name: 'email', type: 'string', required: true, description: 'The owner’s email address' },
      { name: 'name', type: 'string', required: true, description: 'The owner’s name' },
      { name: 'password', type: 'string', required: true, description: 'At least 8 characters' },
      {
        name: 'companyPassword',
        type: 'string',
        required: true,
        description: 'The company gate password — the same one signup asks for',
      },
      { name: 'planId', type: 'string', required: false, description: 'The plan to subscribe to' },
    ],
    responses: [
      { status: '201', description: 'The account, the user and the first API key' },
      { status: '400', description: 'A field is missing or the password is too short' },
      { status: '401', description: 'The company gate password is wrong' },
      { status: '500', description: 'The account could not be provisioned' },
    ],
    docs: 'setup-guide',
  },
  {
    method: 'GET',
    path: '/platform/openapi.json',
    summary: 'The API reference, as an OpenAPI document',
    description:
      'Every endpoint the platform exposes, with its parameters, request body and responses. Feed it to a code generator, or read it to see exactly what is available. It is kept in step with the code: the routes are read from the live router, and a route without an entry here is reported at boot.',
    auth: 'None',
    responses: [
      { status: '200', description: 'The OpenAPI document' },
      { status: '500', description: 'The document could not be built' },
    ],
    docs: 'platform',
  },
  {
    method: 'GET',
    path: '/platform/sse/instances/:instancePublicId/stream',
    summary: 'Stream the events of one instance',
    description:
      'A Server-Sent Events stream of the pairing QR code and the connection state of the instance. It needs a dashboard session — an API key is not accepted — and the instance must belong to the signed-in account.',
    auth: 'Session cookie',
    parameters: [
      {
        name: 'instancePublicId',
        in: 'path',
        type: 'string',
        required: true,
        description: 'The instance public id (inst_xxx)',
      },
    ],
    responses: [
      { status: '200', description: 'The event stream' },
      { status: '401', description: 'No session, or the session has expired' },
      { status: '403', description: 'The instance belongs to another account' },
      { status: '404', description: 'No such instance' },
      { status: '500', description: 'The stream could not be set up' },
    ],
    docs: 'activity',
  },
  {
    method: 'GET',
    path: '/platform/status/',
    summary: 'Read the health of the platform and the WhatsApp session on it',
    description:
      'Everything the platform knows about its own state: the database, Redis, the WhatsApp sessions, the message queue, the disk and the last backup. It answers 503 when the platform is down, so a monitor can use the status code alone. Public — a monitor has no credential, and nothing in the answer is secret.',
    auth: 'None',
    responses: [
      { status: '200', description: 'The platform is healthy, or degraded with the problems listed' },
      { status: '503', description: 'The platform is down' },
    ],
    docs: 'platform',
  },
];
