import { z } from 'zod';
import { createDocument, createSchema } from 'zod-openapi';
type OpenAPIObject = ReturnType<typeof createDocument>;
type OpenAPIInput = Parameters<typeof createDocument>[0];
type SchemaObject = ReturnType<typeof createSchema>['components'][string];
import { exchanges } from './exchanges.js';
import { errorCatalog, errorEnvelope } from './errors.js';
import { headers } from './bindings.js';
import { ContentDescriptor } from './objects.js';
import { ClientFrame, ServerFrame } from './synchronization.js';
import { PROTOCOL_VERSION, Uuid } from './scalars.js';

export function referenceDocument(): OpenAPIObject {
  const components: Record<string, SchemaObject> = {};
  const schema = (definition: z.ZodType, id: string) => {
    const named = definition.meta()?.id === id ? definition : definition.meta({ id });
    const result = createSchema(named, { io: 'output', openapiVersion: '3.1.0' });
    for (const [name, value] of Object.entries(result.components)) {
      const existing = components[name];
      if (existing && JSON.stringify(existing) !== JSON.stringify(value))
        throw new Error('Conflicting schema identifier');
      components[name] = value;
    }
    return result.schema;
  };
  const responseHeaders = Object.fromEntries(
    [headers.dataset, headers.protocol, headers.request].map((header) => [
      header.name,
      { required: true, schema: schema(header.schema, header.name.replaceAll('-', '')) },
    ]),
  );
  const paths: NonNullable<OpenAPIInput['paths']> = {};
  const errors = Object.fromEntries(
    Object.entries(errorCatalog).map(([status, definition]) => [
      status,
      {
        description: 'Explicit refusal',
        headers: responseHeaders,
        content: {
          'application/json': { schema: schema(errorEnvelope(definition), `Error${status}`) },
        },
      },
    ]),
  );
  for (const binding of Object.values(exchanges)) {
    const parameters = [headers.dataset, headers.protocol].map((header) => ({
      in: 'header',
      name: header.name,
      required: !binding.discovery,
      schema: schema(header.schema, header.name.replaceAll('-', '')),
    }));
    parameters.push({
      in: 'header',
      name: headers.attempt.name,
      required: false,
      schema: schema(headers.attempt.schema, 'AttemptId'),
    });
    const responses: Record<string, object> = { ...errors };
    if (binding.transport === 'reference') {
      responses['200'] = {
        description: 'Authenticated raw contract document',
        headers: responseHeaders,
        content: {
          'application/vnd.oai.openapi+json': {},
          'text/html': { schema: { type: 'string' } },
        },
      };
      parameters.push({
        in: 'header',
        name: 'Accept',
        required: true,
        schema: { type: 'string', enum: ['application/vnd.oai.openapi+json', 'text/html'] },
      });
    } else if (binding.transport === 'content') {
      schema(ContentDescriptor, 'ContentDescriptor');
      responses['200'] = {
        description: 'Streamed complete binary content',
        headers: {
          ...responseHeaders,
          'Content-Length': {
            required: true,
            schema: schema(ContentDescriptor.shape.byte_length, 'ObjectLength'),
          },
          'Atlas-Content-SHA256': {
            required: true,
            schema: schema(ContentDescriptor.shape.sha256, 'Sha256'),
          },
          'Content-Disposition': {
            required: true,
            schema: { type: 'string', enum: ['inline', 'attachment'] },
          },
        },
        content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
      };
      parameters.push({
        in: 'path',
        name: 'object_id',
        required: true,
        schema: schema(Uuid, 'Uuid'),
      });
      parameters.push({
        in: 'query',
        name: 'disposition',
        required: true,
        schema: { type: 'string', enum: ['inline', 'attachment'] },
      });
    } else {
      const success = schema(binding.success, `${binding.operationId}Response`);
      for (const status of binding.successStatuses)
        responses[String(status)] = {
          description: 'Validated result',
          headers: responseHeaders,
          content: { 'application/json': { schema: success } },
        };
    }
    const request = schema(binding.request.schema, `${binding.operationId}Request`);
    const requestBody =
      binding.method === 'GET'
        ? undefined
        : {
            required: true,
            content:
              binding.transport === 'upload'
                ? {
                    'multipart/form-data': {
                      schema: {
                        type: 'object',
                        required: ['descriptor', 'file'],
                        additionalProperties: false,
                        properties: {
                          descriptor: request,
                          file: { type: 'string', format: 'binary' },
                        },
                      },
                      encoding: {
                        descriptor: { contentType: 'application/json' },
                        file: { contentType: 'application/octet-stream' },
                      },
                    },
                  }
                : { 'application/json': { schema: request } },
          };
    const operation = {
      operationId: binding.operationId,
      summary: binding.operationId,
      security: [{ bearerAuth: [] }],
      parameters,
      responses,
      ...(requestBody ? { requestBody } : {}),
    };
    paths[binding.path] = { [binding.method.toLowerCase()]: operation };
  }
  schema(ClientFrame, 'ClientFrame');
  schema(ServerFrame, 'ServerFrame');
  return createDocument({
    openapi: '3.1.0',
    info: { title: 'Atlas Protocol', version: PROTOCOL_VERSION },
    paths,
    components: {
      schemas: components,
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
  });
}

export function exportReference(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(referenceDocument(), null, 2) + '\n');
}
