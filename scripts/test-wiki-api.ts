/**
 * Quick verification script: Test Feishu Wiki API capabilities.
 * Run with: npx tsx scripts/test-wiki-api.ts
 */
import * as lark from '@larksuiteoapi/node-sdk';

const APP_ID = 'cli_a90db79577f8dbd2';
const APP_SECRET = 'XYSTpLHcLDpkzJKqrvlOngDYd0wQVMEr';

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  disableTokenCache: false,
});

async function testWikiApi() {
  console.log('=== Testing Feishu Wiki API ===\n');

  // Step 1: List existing wiki spaces
  console.log('1. Listing existing wiki spaces...');
  try {
    const spacesResp = await client.wiki.v2.space.list({
      params: { page_size: 10 },
    });
    console.log('  Spaces:', JSON.stringify(spacesResp.data, null, 2));
  } catch (err: any) {
    console.log('  Error listing spaces:', err.msg || err.message);
    console.log('  Code:', err.code);
    if (err.code === 11232) {
      console.log('  -> Missing wiki:wiki scope. Need to add permission in Feishu dev console.');
    }
  }

  // Step 2: Try to create a test wiki space
  console.log('\n2. Creating test wiki space "MetaMemory-Test"...');
  let spaceId: string | undefined;
  try {
    const createResp = await client.wiki.v2.space.create({
      data: {
        name: 'MetaMemory-Test',
        description: 'Test wiki space for MetaMemory sync verification',
      },
    });
    spaceId = (createResp.data as any)?.space?.space_id;
    console.log('  Created space:', spaceId);
    console.log('  Full response:', JSON.stringify(createResp.data, null, 2));
  } catch (err: any) {
    console.log('  Error creating space:', err.msg || err.message);
    console.log('  Code:', err.code);
    console.log('  Full error:', JSON.stringify(err, null, 2));
  }

  if (!spaceId) {
    console.log('\n  Cannot proceed without a wiki space. Checking permissions...');

    // Try alternative: create a document in Drive instead
    console.log('\n3. Testing Drive document creation as fallback...');
    try {
      const docResp = await client.docx.v1.document.create({
        data: {
          title: 'MetaMemory-Test-Doc',
        },
      });
      console.log('  Created document:', JSON.stringify(docResp.data, null, 2));

      const docId = (docResp.data as any)?.document?.document_id;
      if (docId) {
        // Try adding blocks
        console.log('\n4. Adding content blocks to document...');
        const blocksResp = await client.docx.v1.documentBlockChildren.create({
          path: { document_id: docId, block_id: docId },
          data: {
            children: [
              {
                block_type: 3, // heading1
                heading1: {
                  elements: [{ text_run: { content: 'Test Heading' } }],
                },
              },
              {
                block_type: 2, // text
                text: {
                  elements: [{ text_run: { content: 'This is a test paragraph from MetaBot sync verification.' } }],
                },
              },
              {
                block_type: 14, // code
                code: {
                  elements: [{ text_run: { content: 'console.log("hello from MetaBot!");' } }],
                  language: 17, // JavaScript
                },
              },
            ],
            index: 0,
          },
        });
        console.log('  Added blocks:', JSON.stringify(blocksResp.data, null, 2));

        // Clean up: delete the test document
        console.log('\n5. Cleaning up test document...');
        try {
          await client.drive.v1.file.delete({
            path: { file_token: docId },
            params: { type: 'docx' },
          });
          console.log('  Deleted test document.');
        } catch (delErr: any) {
          console.log('  Cleanup error (non-critical):', delErr.msg || delErr.message);
        }
      }
    } catch (err: any) {
      console.log('  Error creating document:', err.msg || err.message);
      console.log('  Code:', err.code);
    }

    return;
  }

  // If we got a space, create a node (page) in it
  console.log('\n3. Creating a wiki page node...');
  try {
    const nodeResp = await client.wiki.v2.spaceNode.create({
      path: { space_id: spaceId },
      data: {
        obj_type: 'docx',
        title: 'Test Page',
        parent_node_token: '',
      },
    });
    const node = (nodeResp.data as any)?.node;
    console.log('  Created node:', JSON.stringify(node, null, 2));

    if (node?.obj_token) {
      const docId = node.obj_token;

      // Add blocks to the wiki page's document
      console.log('\n4. Adding blocks to wiki page document...');
      const blocksResp = await client.docx.v1.documentBlockChildren.create({
        path: { document_id: docId, block_id: docId },
        data: {
          children: [
            {
              block_type: 3,
              heading1: {
                elements: [{ text_run: { content: 'MetaMemory Sync Test' } }],
              },
            },
            {
              block_type: 2,
              text: {
                elements: [
                  { text_run: { content: 'This wiki page was created programmatically by ' } },
                  { text_run: { content: 'MetaBot', text_element_style: { bold: true } } },
                  { text_run: { content: ' sync service.' } },
                ],
              },
            },
          ],
          index: 0,
        },
      });
      console.log('  Added blocks:', JSON.stringify(blocksResp.data, null, 2));
    }

    // Clean up: delete the test node
    console.log('\n5. Cleaning up...');
    // Note: we'll leave the space for now, it can be used for actual sync
  } catch (err: any) {
    console.log('  Error creating node:', err.msg || err.message);
    console.log('  Code:', err.code);
  }

  console.log('\n=== Wiki API verification complete ===');
  if (spaceId) {
    console.log(`Wiki space ID: ${spaceId}`);
    console.log('This space can be used for MetaMemory sync.');
  }
}

testWikiApi().catch(console.error);
