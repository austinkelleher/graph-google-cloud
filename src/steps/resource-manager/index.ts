import {
  IntegrationStep,
  Entity,
  JobState,
  Relationship,
  createDirectRelationship,
  createMappedRelationship,
  RelationshipDirection,
} from '@jupiterone/integration-sdk-core';
import { ResourceManagerClient } from './client';
import { IntegrationConfig, IntegrationStepContext } from '../../types';
import {
  createFolderEntity,
  createGoogleWorkspaceEntityTypeAssignedIamRoleMappedRelationship,
  createOrganizationEntity,
  createProjectEntity,
  getConditionRelationshipProperties,
} from './converters';
import {
  STEP_RESOURCE_MANAGER_IAM_POLICY,
  STEP_RESOURCE_MANAGER_PROJECT,
  IAM_SERVICE_ACCOUNT_ASSIGNED_ROLE_RELATIONSHIP_TYPE,
  PROJECT_ENTITY_TYPE,
  STEP_RESOURCE_MANAGER_ORGANIZATION,
  ORGANIZATION_ENTITY_TYPE,
  ORGANIZATION_ENTITY_CLASS,
  STEP_RESOURCE_MANAGER_FOLDERS,
  FOLDER_ENTITY_TYPE,
  FOLDER_ENTITY_CLASS,
  ORGANIZATION_HAS_FOLDER_RELATIONSHIP_TYPE,
  FOLDER_HAS_FOLDER_RELATIONSHIP_TYPE,
  STEP_RESOURCE_MANAGER_ORG_PROJECT_RELATIONSHIPS,
  ORGANIZATION_HAS_PROJECT_RELATIONSHIP_TYPE,
  FOLDER_HAS_PROJECT_RELATIONSHIP_TYPE,
} from './constants';
import {
  IAM_SERVICE_ACCOUNT_ENTITY_TYPE,
  IAM_ROLE_ENTITY_TYPE,
  GOOGLE_USER_ENTITY_TYPE,
  GOOGLE_GROUP_ENTITY_TYPE,
  IAM_ROLE_ENTITY_CLASS,
  IAM_USER_ENTITY_CLASS,
  STEP_IAM_CUSTOM_ROLES,
  STEP_IAM_SERVICE_ACCOUNTS,
  GOOGLE_GROUP_ASSIGNED_IAM_ROLE_RELATIONSHIP_TYPE,
  GOOGLE_USER_ASSIGNED_IAM_ROLE_RELATIONSHIP_TYPE,
  STEP_IAM_MANAGED_ROLES,
  GOOGLE_DOMAIN_ENTITY_TYPE,
  IAM_PRINCIPAL_TYPE,
} from '../iam';
import { cloudresourcemanager_v3 } from 'googleapis';
import {
  getIamManagedRoleData,
  ParsedIamMember,
  parseIamMember,
} from '../../utils/iam';
import { createIamRoleEntity } from '../iam/converters';
import { RelationshipClass } from '@jupiterone/data-model';
import { cacheProjectNameAndId } from '../../utils/jobState';
import { CREATE_IAM_ENTITY_MAP } from './createIamEntities';

export * from './constants';

export interface IamUserEntityWithParsedMember {
  parsedMember: ParsedIamMember;
  userEntity: Entity | null;
}

export async function maybeFindIamUserEntityWithParsedMember({
  jobState,
  member,
}: {
  jobState: JobState;
  member: string;
}): Promise<IamUserEntityWithParsedMember> {
  const parsedMember = parseIamMember(member);
  const { identifier: parsedIdentifier, type: parsedMemberType } = parsedMember;

  if (
    !parsedIdentifier ||
    parsedMemberType === 'domain' ||
    parsedMemberType === 'group'
  ) {
    // This is a member that we do not want to create. For example: `allAuthenticatedUsers`
    // or `domain:{domain}` or `group:abc@123.com`
    return {
      parsedMember,
      userEntity: null,
    };
  }

  // We always want to find or create relationships to user entities. Since
  // the same user can have multiple roles, there is a possibility that a
  // user is created earlier in this step. In order to avoid duplicate entity
  // keys, we need to look for the user before creating anything.
  if (parsedMember.type === 'serviceAccount') {
    const userEntity = await jobState.findEntity(parsedIdentifier);

    // We already created service accounts in another step. If this service
    // account does not exist, it's possible that it was created in between
    // steps. The caller handles the case that not entity is returned, so we
    // will just ignore it.
    return {
      parsedMember,
      userEntity,
    };
  }

  return {
    parsedMember,
    userEntity: null,
  };
}

export async function getPermissionsForManagedRole(
  jobState: JobState,
  roleName: string,
): Promise<string[] | null | undefined> {
  const iamManagedRoleData = await getIamManagedRoleData(jobState);
  return iamManagedRoleData[roleName]?.includedPermissions;
}

export async function findOrCreateIamRoleEntity({
  jobState,
  roleName,
}: {
  jobState: JobState;
  roleName: string;
}) {
  const roleEntity = await jobState.findEntity(roleName);
  if (roleEntity) {
    return roleEntity;
  }

  const includedPermissions = await getPermissionsForManagedRole(
    jobState,
    roleName,
  );
  return jobState.addEntity(
    createIamRoleEntity(
      {
        name: roleName,
        title: roleName,
        includedPermissions,
      },
      {
        custom: false,
      },
    ),
  );
}

// This is an optimization to only fetch the iam_role if it is needed for a relationship
export function shouldMakeTargetIamRelationships(
  iamUserEntityWithParsedMember: IamUserEntityWithParsedMember,
) {
  return (
    iamUserEntityWithParsedMember.userEntity ||
    iamUserEntityWithParsedMember.parsedMember.type === 'domain' ||
    iamUserEntityWithParsedMember.parsedMember.type === 'group' ||
    iamUserEntityWithParsedMember.parsedMember.type === 'user'
  );
}

export function buildIamTargetRelationship({
  iamEntity,
  iamUserEntityWithParsedMember,
  projectId,
  condition,
  relationshipDirection,
}: {
  iamEntity: Entity;
  iamUserEntityWithParsedMember: IamUserEntityWithParsedMember;
  relationshipDirection: RelationshipDirection;
  projectId?: string;
  condition?: cloudresourcemanager_v3.Schema$Expr;
}): Relationship | undefined {
  const iamEntityToTargetRelationship =
    relationshipDirection === RelationshipDirection.FORWARD;

  if (iamUserEntityWithParsedMember.userEntity) {
    // Create a direct relationship. This is a user entity that _only_ exists
    // in the Google Cloud integration (e.g. a GCP service account)
    return createDirectRelationship({
      _class: RelationshipClass.ASSIGNED,
      from: iamEntityToTargetRelationship
        ? iamEntity
        : iamUserEntityWithParsedMember.userEntity,
      to: iamEntityToTargetRelationship
        ? iamUserEntityWithParsedMember.userEntity
        : iamEntity,
      properties: {
        projectId: projectId,
        ...(condition && getConditionRelationshipProperties(condition)),
      },
    });
  } else {
    let targetEntityType: IAM_PRINCIPAL_TYPE;
    const parsedMemberType = iamUserEntityWithParsedMember.parsedMember.type;
    if (parsedMemberType === 'domain') {
      targetEntityType = GOOGLE_DOMAIN_ENTITY_TYPE;
    } else if (parsedMemberType === 'group') {
      targetEntityType = GOOGLE_GROUP_ENTITY_TYPE;
    } else if (parsedMemberType === 'user') {
      targetEntityType = GOOGLE_USER_ENTITY_TYPE;
    }

    // Create a mapped relationship where the target entity exists is owned
    // by the Google Workspace integration.
    return createGoogleWorkspaceEntityTypeAssignedIamRoleMappedRelationship({
      iamEntity: iamEntity,
      targetEntity: CREATE_IAM_ENTITY_MAP[targetEntityType!](
        iamUserEntityWithParsedMember,
      ),
      relationshipDirection,
      projectId,
      condition,
    });
  }
}

export async function fetchResourceManagerOrganization(
  context: IntegrationStepContext,
): Promise<void> {
  const {
    jobState,
    instance: { config },
  } = context;
  const client = new ResourceManagerClient({ config });

  const organization = await client.getOrganization();
  await jobState.addEntity(createOrganizationEntity(organization));
}

export async function fetchResourceManagerFolders(
  context: IntegrationStepContext,
): Promise<void> {
  const {
    jobState,
    instance: { config },
  } = context;
  const client = new ResourceManagerClient({ config });

  // Sending parentFolder name instead of Entity would be "cheaper", but we'd need to use
  // many jobState.findEntity calls to fetch parentFolder entity
  const getAllInnerFolders = async (
    client: ResourceManagerClient,
    parentFolder: Entity,
    parentFolderName: string,
  ) => {
    await client.iterateFolders(async (folder) => {
      const folderEntity = createFolderEntity(folder);
      await jobState.addEntity(folderEntity);

      // Builds folder -> HAS -> folder
      await jobState.addRelationship(
        createDirectRelationship({
          _class: RelationshipClass.HAS,
          from: parentFolder,
          to: folderEntity,
        }),
      );

      await getAllInnerFolders(client, folderEntity, folder.name!);
    }, parentFolderName);
  };

  const organizationEntity = await jobState.findEntity(
    `organizations/${client.organizationId}`,
  );
  if (organizationEntity) {
    // Iterate organization's folders (starting point)
    await client.iterateFolders(async (folder) => {
      const folderEntity = createFolderEntity(folder);
      await jobState.addEntity(folderEntity);

      // Builds organization -> HAS -> folder
      await jobState.addRelationship(
        createDirectRelationship({
          _class: RelationshipClass.HAS,
          from: organizationEntity,
          to: folderEntity,
        }),
      );

      await getAllInnerFolders(client, folderEntity, folder.name!);
    });
  }
}

export async function buildOrgFolderProjectMappedRelationships(
  context: IntegrationStepContext,
): Promise<void> {
  const {
    jobState,
    instance: { config },
  } = context;
  const client = new ResourceManagerClient({ config });
  const organizationEntity = await jobState.findEntity(
    `organizations/${client.organizationId}`,
  );
  // Organization -> HAS -> Projects
  if (organizationEntity) {
    await client.iterateProjects(async (project) => {
      const projectEntity = createProjectEntity(client.projectId, project);
      await cacheProjectNameAndId(jobState, project);

      await jobState.addRelationship(
        createMappedRelationship({
          _class: RelationshipClass.HAS,
          _type: ORGANIZATION_HAS_PROJECT_RELATIONSHIP_TYPE,
          _mapping: {
            relationshipDirection: RelationshipDirection.FORWARD,
            sourceEntityKey: organizationEntity._key,
            targetFilterKeys: [['_type', '_key']],
            targetEntity: {
              ...projectEntity,
              _rawData: undefined,
            },
          },
        }),
      );
    });
  }

  // Folder -> HAS (mappedRelationship) -> Projects
  await jobState.iterateEntities(
    {
      _type: FOLDER_ENTITY_TYPE,
    },
    async (folderEntity) => {
      await client.iterateProjects(async (project) => {
        const projectEntity = createProjectEntity(client.projectId, project);
        await cacheProjectNameAndId(jobState, project);

        await jobState.addRelationship(
          createMappedRelationship({
            _class: RelationshipClass.HAS,
            _type: FOLDER_HAS_PROJECT_RELATIONSHIP_TYPE,
            _mapping: {
              relationshipDirection: RelationshipDirection.FORWARD,
              sourceEntityKey: folderEntity._key,
              targetFilterKeys: [['_type', '_key']],
              targetEntity: {
                ...projectEntity,
                _rawData: undefined,
              },
            },
          }),
        );
      }, folderEntity.name as string);
    },
  );
}

export async function fetchResourceManagerProject(
  context: IntegrationStepContext,
): Promise<void> {
  const {
    jobState,
    instance: { config },
    logger,
  } = context;
  const client = new ResourceManagerClient({ config });

  let project;
  try {
    project = await client.getProject();
    await cacheProjectNameAndId(jobState, project);
  } catch (err) {
    // This step _always_ executes because it creates a root `Account` entity for the integration instance.
    // However, users can only fetch the project details if cloudresourcemanager API is enabled.
    const message =
      'Could not fetch project from Cloud Resource Manager API. Ensure the API is enabled and the service account has the ' +
      '`resourcemanager.projects.get` permission (see ' +
      'https://github.com/JupiterOne/graph-google-cloud/blob/master/docs/development.md#enabling-google-cloud-services) ' +
      `${JSON.stringify({ code: err.code, message: err.message })}`;
    if (err.code === 403) {
      logger.warn({ err }, message);
    } else {
      logger.error({ err }, message);
    }
    logger.publishEvent({
      name: 'auth_error',
      description: message,
    });
  }

  const projectEntity = createProjectEntity(client.projectId, project);

  await jobState.setData(PROJECT_ENTITY_TYPE, projectEntity);
  await jobState.addEntity(projectEntity);
}

export async function fetchResourceManagerIamPolicy(
  context: IntegrationStepContext,
): Promise<void> {
  const {
    jobState,
    instance: { config },
    logger,
  } = context;
  const client = new ResourceManagerClient({ config });
  const relationships = new Set<string>();

  await client.iteratePolicyMemberBindings(async (data) => {
    if (!data.binding.role) {
      logger.warn(
        { binding: data.binding },
        'Unable to build relationships for binding. Binding does not have an associated role.',
      );
      return;
    }

    const iamUserEntityWithParsedMember =
      await maybeFindIamUserEntityWithParsedMember({
        jobState,
        member: data.member,
      });

    if (shouldMakeTargetIamRelationships(iamUserEntityWithParsedMember)) {
      const iamRoleEntity = await findOrCreateIamRoleEntity({
        jobState,
        roleName: data.binding.role,
      });

      const relationship = buildIamTargetRelationship({
        iamUserEntityWithParsedMember,
        iamEntity: iamRoleEntity,
        relationshipDirection: RelationshipDirection.REVERSE,
        projectId: client.projectId,
        condition: data.binding.condition,
      });

      if (!relationship || relationships.has(relationship._key)) {
        return;
      }

      await jobState.addRelationship(relationship);
      relationships.add(relationship._key);
    }
  });
}

export const resourceManagerSteps: IntegrationStep<IntegrationConfig>[] = [
  {
    id: STEP_RESOURCE_MANAGER_ORGANIZATION,
    name: 'Resource Manager Organization',
    entities: [
      {
        resourceName: 'Organization',
        _type: ORGANIZATION_ENTITY_TYPE,
        _class: ORGANIZATION_ENTITY_CLASS,
      },
    ],
    relationships: [],
    dependsOn: [],
    executionHandler: fetchResourceManagerOrganization,
  },
  {
    id: STEP_RESOURCE_MANAGER_FOLDERS,
    name: 'Resource Manager Folders',
    entities: [
      {
        resourceName: 'Folder',
        _type: FOLDER_ENTITY_TYPE,
        _class: FOLDER_ENTITY_CLASS,
      },
    ],
    relationships: [
      {
        _class: RelationshipClass.HAS,
        _type: ORGANIZATION_HAS_FOLDER_RELATIONSHIP_TYPE,
        sourceType: ORGANIZATION_ENTITY_TYPE,
        targetType: FOLDER_ENTITY_TYPE,
      },
      {
        _class: RelationshipClass.HAS,
        _type: FOLDER_HAS_FOLDER_RELATIONSHIP_TYPE,
        sourceType: FOLDER_ENTITY_TYPE,
        targetType: FOLDER_ENTITY_TYPE,
      },
    ],
    dependsOn: [STEP_RESOURCE_MANAGER_ORGANIZATION],
    executionHandler: fetchResourceManagerFolders,
  },
  {
    id: STEP_RESOURCE_MANAGER_ORG_PROJECT_RELATIONSHIPS,
    name: 'Resource Manager Projects',
    entities: [],
    relationships: [
      {
        _class: RelationshipClass.HAS,
        _type: ORGANIZATION_HAS_PROJECT_RELATIONSHIP_TYPE,
        sourceType: ORGANIZATION_ENTITY_TYPE,
        targetType: PROJECT_ENTITY_TYPE,
      },
      {
        _class: RelationshipClass.HAS,
        _type: FOLDER_HAS_PROJECT_RELATIONSHIP_TYPE,
        sourceType: FOLDER_ENTITY_TYPE,
        targetType: PROJECT_ENTITY_TYPE,
      },
    ],
    dependsOn: [
      STEP_RESOURCE_MANAGER_ORGANIZATION,
      STEP_RESOURCE_MANAGER_FOLDERS,
    ],
    executionHandler: buildOrgFolderProjectMappedRelationships,
  },
  {
    id: STEP_RESOURCE_MANAGER_PROJECT,
    name: 'Resource Manager Project',
    entities: [
      {
        resourceName: 'Project',
        _type: 'google_cloud_project',
        _class: 'Account',
      },
    ],
    relationships: [],
    dependsOn: [],
    executionHandler: fetchResourceManagerProject,
  },
  {
    id: STEP_RESOURCE_MANAGER_IAM_POLICY,
    name: 'Resource Manager IAM Policy',
    entities: [
      {
        resourceName: 'IAM Role',
        _type: IAM_ROLE_ENTITY_TYPE,
        _class: IAM_ROLE_ENTITY_CLASS,
      },
      {
        resourceName: 'IAM User',
        _type: GOOGLE_USER_ENTITY_TYPE,
        _class: IAM_USER_ENTITY_CLASS,
      },
    ],
    relationships: [
      {
        _class: RelationshipClass.ASSIGNED,
        _type: IAM_SERVICE_ACCOUNT_ASSIGNED_ROLE_RELATIONSHIP_TYPE,
        sourceType: IAM_SERVICE_ACCOUNT_ENTITY_TYPE,
        targetType: IAM_ROLE_ENTITY_TYPE,
      },
      {
        _type: GOOGLE_GROUP_ASSIGNED_IAM_ROLE_RELATIONSHIP_TYPE,
        _class: RelationshipClass.ASSIGNED,
        sourceType: GOOGLE_GROUP_ENTITY_TYPE,
        targetType: IAM_ROLE_ENTITY_TYPE,
      },
      {
        _type: GOOGLE_USER_ASSIGNED_IAM_ROLE_RELATIONSHIP_TYPE,
        _class: RelationshipClass.ASSIGNED,
        sourceType: GOOGLE_USER_ENTITY_TYPE,
        targetType: IAM_ROLE_ENTITY_TYPE,
      },
    ],
    dependsOn: [
      STEP_IAM_CUSTOM_ROLES,
      STEP_IAM_SERVICE_ACCOUNTS,
      STEP_IAM_MANAGED_ROLES,
    ],
    executionHandler: fetchResourceManagerIamPolicy,
  },
];
