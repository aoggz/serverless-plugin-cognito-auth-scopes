
class ServerlessCognitoAuthScopes {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = 'aws';

    this.consoleLog = this.serverless.cli.consoleLog.bind(this);
    this.customVars = this.serverless.variables.service.custom;
    const naming = this.serverless.providers.aws.naming;
    this.getMethodLogicalId = naming.getMethodLogicalId.bind(naming);
    this.normalizePath = naming.normalizePath.bind(naming);

    this._beforeDeploy = this.beforeDeploy.bind(this)
    this._afterDeploy = this.afterDeploy.bind(this)

    this.hooks = {
      'before:package:finalize': this._beforeDeploy,
      'after:deploy:deploy': this._afterDeploy
    };

    this.documentationParts = [];

    this.commands = {
      downloadDocumentation: {
        usage: 'Download API Gateway documentation from AWS',
        lifecycleEvents: [
          'downloadDocumentation',
        ],
        options: {
          outputFileName: {
            required: true,
          },
        },
      }
    };
  }

  beforeDeploy() {
    this.cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;

    // The default rest API reference
    let restApiId = {
      Ref: 'ApiGatewayRestApi',
    };

    // Use the provider API gateway if one has been provided.
    if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
      restApiId = this.serverless.service.provider.apiGateway.restApiId
    }

    this.apiGatewayMethodsToUpdate = [];

    // Add models to method resources
    this.serverless.service.getAllFunctions().forEach(functionName => {
      const func = this.serverless.service.getFunction(functionName);
      func.events.forEach(this._updateCfTemplateFromHttp);
    });

    // Add models
    this.cfTemplate.Outputs.AwsApiGatewayRestApiId = {
      Description: 'API ID',
      Value: restApiId,
    };
  }

  async afterDeploy() {
    const stackName = this.serverless.providers.aws.naming.getStackName(this.options.stage);
    const response = await this.serverless.providers.aws.request(
      'CloudFormation',
      'describeStacks',
      { StackName: stackName },
      this.options.stage,
      this.options.region
    );

    this.consoleLog(response.Stacks[0].Outputs);

  }

  _updateCfTemplateFromHttp(event) {
    if (event.http && event.http.authorizer && event.http.cognito && event.http.cognito.scopes) {
      const resourceName = this.normalizePath(event.http.path);
      const methodLogicalId = this.getMethodLogicalId(resourceName, event.http.method);

      const cfOutputName = `${methodLogicalId}Id`;

      this.cfTemplate.Outputs[cfOutputName] = {
        Value: { Ref: methodLogicalId }
      }

      this.apiGatewayMethodsToUpdate.push({
        cfOutputName,
        verb: event.http.method
      });
    }
  }
}

module.exports = ServerlessCognitoAuthScopes;