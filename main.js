/**
 * 腾讯云证书更新器：自动更新、上传和删除 CDN 域名的 SSL 证书。
 * 
 * 使用前请确保已安装以下依赖：
 * - tencentcloud-sdk-nodejs-common
 * - dotenv
 * - crypto
 * 
 * 使用方法：
 * 1. 设置环境变量 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY，或在 .env 文件中配置。
 * 2. 执行脚本并传入证书所在目录路径（默认为当前工作目录）。
 * 
 * 示例：node main.js /path/to/cert
 */

// 定义证书命名格式
const CERT = "fullchain.pem";
const KEY = "privkey.pem";

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { X509Certificate } = require('crypto');
const TencentCloudCommon = require("tencentcloud-sdk-nodejs-common");

/**
 * CertUpdater 类：用于管理腾讯云证书的更新、上传和删除。
 */
class CertUpdater {
  /**
   * 实例化 client。
   * 
   * @param {Object} config - 包含 secretId 和 secretKey 的配置对象
   */
  constructor(config) {
    this.sslClient = this.createClient(config, "ssl", "2019-12-05");
    this.cdnClient = this.createClient(config, "cdn", "2018-06-06");
    this.sslCerts = null; // 腾讯云 SSL 证书列表
  }

  /**
   * 主流程：更新证书。
   * 
   * @param {string} certPath - 证书文件所在路径
   */
  async update(certPath) {
    // 1. 加载证书和密钥文件
    const { cert, key } = this.loadCertificateAndKeyFiles(certPath);

    // 2. 解析证书信息
    const certInfo = this.parseCertificateInfo(cert);

    // 3. 查找或上传证书，返回证书信息 基于 DescribeCertificate 接口
    const certificate = await this.getOrUploadCertificate(certInfo, cert, key);

    // 4. 获取加速域名
    const domains = await this.getAllDomains();

    // 5. 更新域名证书
    await this.updateDomainCerts(domains, certificate);

    // 6. 删除旧证书
    await this.deleteOldCertificates(certInfo, certificate);
  }

  /**
   * 加载证书和密钥文件。
   * 
   * @param {string} certPath - 证书文件所在路径
   * @returns {{ cert: string, key: string }} - 证书和密钥内容
   */
  loadCertificateAndKeyFiles(certPath) {
    if (!fs.existsSync(certPath)) {
      throw new Error(`证书路径不存在: ${certPath}`);
    }

    let cert, key;
    try {
      cert = fs.readFileSync(`${certPath}/${CERT}`, "utf-8");
      key = fs.readFileSync(`${certPath}/${KEY}`, "utf-8");
    } catch (err) {
      throw new Error(`读取证书文件失败 (路径: ${certPath}):\n ${err}`);
    }

    return { cert, key };
  }

  /**
   * 解析 PEM 格式的证书内容，提取指纹、过期时间、域名列表及主域名。
   * 
   * @param {string} certPath - 证书文件所在路径
   * @returns {Object} 包含证书信息的对象
   * @returns {string} returns.fingerprint - 证书的 SHA1 指纹（大写十六进制）
   * @returns {string} returns.expires - 证书的过期日期（UTC 格式，示例：'Dec 24 23:59:59 2023 GMT'）
   * @returns {string} returns.domain - 证书的主域名（优先取 CN，若无则取第一个 SAN 域名）
   * @returns {string[]} returns.subjectAltName - 证书中的所有域名列表（包括 SAN 和 CN）
   */
  parseCertificateInfo(pemContent) {
    //输入验证
    if (!pemContent || typeof pemContent !== 'string') {
      throw new Error('证书内容必须为非空字符串');
    }

    //拆分 PEM 文件，取第一张证书（叶子证书）
    const certs = pemContent.split(/(?=-----BEGIN CERTIFICATE-----)/).filter(Boolean);
    if (certs.length === 0) {
      throw new Error('证书内容中未找到有效证书');
    }
    const leafCertPem = certs[0];

    //创建 X509Certificate 对象解析证书
    const cert = new X509Certificate(leafCertPem);

    // 提取证书过期时间并判断是否过期
    const expires = cert.validTo;
    const diffMs = new Date(expires).getTime() - Date.now();
    const days = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
    if (diffMs <= 0) {
      throw Error(`证书已过期 ${days} 天！\n服务中止，请重新选择证书文件。`);
    }

    //计算证书 SHA1 指纹（基于证书原始二进制数据）
    const fingerprint = crypto.createHash('sha1').update(cert.raw).digest('hex').toUpperCase();

    //提取证书的域名列表
    let subjectAltName = cert.subjectAltName
      ? cert.subjectAltName
        .split(/,\s*/)
        .map(item => item.trim())
        .filter(item => item.startsWith('DNS:'))
        .map(item => item.replace(/^DNS:/, ''))
      : [];

    //提取证书主体中的 CN（可能的主域名）
    let domain = null;
    const cnMatch = cert.subject.match(/CN=([^,]+)/);
    if (cnMatch) {
      domain = cnMatch[1].trim();
      if (!subjectAltName.includes(domain)) subjectAltName.push(domain);
    }

    //如果 subjectAltName 为空，抛出异常
    if (subjectAltName.length === 0) {
      throw new Error('无法从证书中提取域名信息');
    }

    //如果没有 CN，则使用第一个 SAN 域名作为主域名
    if (!domain && subjectAltName.length > 0) {
      domain = subjectAltName[0];
    }

    console.log(`证书解析成功：{\n 主题：${domain}\n 可选名称：${subjectAltName}\n 指纹: ${fingerprint}\n 过期时间: ${expires}\n 剩余日期：${days}\n}`);
    return { fingerprint, expires, domain, subjectAltName };
  }

  /**
   * 创建腾讯云服务客户端。
   * 
   * @param {Object} config - 包含 secretId 和 secretKey 的配置对象
   * @param {string} service - 服务名称（如 "ssl", "cdn"）
   * @param {string} version - API 版本（如 "2019-12-05"）
   * @param {string} [customEndpoint] - 可选的自定义端点
   * @returns {Object} - 腾讯云客户端实例
   */
  createClient(config, service, version, customEndpoint) {
    return new TencentCloudCommon.CommonClient(
      customEndpoint || `${service}.tencentcloudapi.com`,
      version,
      {
        credential: { secretId: config.secretId, secretKey: config.secretKey },
        region: "",
        profile: { httpProfile: { endpoint: customEndpoint || `${service}.tencentcloudapi.com` } }
      }
    );
  }

  /**
   * 查找或上传证书并返回托管证书信息
   * 
   * @param {Object} certInfo - 证书信息
   * @param {string} cert - 证书内容
   * @param {string} key - 密钥内容
   * @returns {Object<Certificates>} - 托管证书信息
   */
  async getOrUploadCertificate(certInfo, cert, key) {
    // 根据待上传证书信息的 CN 模糊查找 SSL 证书列表
    try {
      this.sslCerts = await this.sslClient.request("DescribeCertificates", {
        "SearchKey": certInfo.domain,
        "ExpirationSort": "DESC",
        "FilterSource": "upload",
        "Limit": 200
      });
    } catch (err) {
      console.error(`获取证书列表失败，将上传新证书:\n ${err}`);
    }

    let certificateId;
    // 查找是否已经有匹配的证书：指纹相同
    if (this.sslCerts && Array.isArray(this.sslCerts.Certificates)) {
      const matchingCert = this.sslCerts.Certificates.find(item => item.Alias === certInfo.fingerprint);
      if (matchingCert) {
        console.log(`找到匹配证书 - ID: ${matchingCert.CertificateId}`);
        certificateId = matchingCert.CertificateId;
      }
    }

    // 无匹配证书，将本地证书作为新证书上传
    if (!certificateId) {
      try {
        const result = await this.sslClient.request("UploadCertificate", {
          CertificatePublicKey: cert,
          CertificatePrivateKey: key,
          Alias: certInfo.fingerprint  // 上传时把已计算的指纹写入到备注中，不然得调用另一个 API 才能得到指纹值
        });
        console.log(`上传新证书，ID: ${result.CertificateId}`);
        certificateId = result.CertificateId;
      } catch (err) {
        console.error(`证书上传失败:\n ${err}`);
        throw err;
      }
    }

    // 根据证书 ID 重新查询，获取腾讯云端的托管证书信息
    try {
      const result = await this.sslClient.request("DescribeCertificate", { "CertificateId": certificateId });
      if (Array.isArray(result.SubjectAltName) && result.SubjectAltName.length === 0) {
        result.SubjectAltName = [result.Domain];
      }
      if (!result.SubjectAltName.includes(result.Domain)) {
        result.SubjectAltName.push(result.Domain);
      }
      return result;
    } catch (err) {
      console.error(`异常错误:\n ${err}`);
      return {
        CertificateId: certificateId,
        SubjectAltName: certInfo.subjectAltName,
        CertEndTime: certInfo.expires
      };
    }
  }

  /**
   * 获取所有启用了 HTTPS 的在线 CDN 域名。
   * 
   * @returns {Array} - CDN 域名对象列表
   */
  async getAllDomains() {
    let allDomains = [];
    try {
      const result = await this.cdnClient.request("DescribeDomains", {
        Limit: 200,
        Filters: [
          { "Name": "status", "Value": ["online"] },
          { "Name": "https", "Value": ["on"] }
        ]
      });
      allDomains = result.Domains || [];
    } catch (err) {
      console.error(`获取 CDN 域名列表失败:\n ${err}`);
    }
    return [...new Map(allDomains.map(item => [item.Domain, item])).values()];
  }

  /**
   * 更新匹配域名的证书。
   * @param {Array} domains - CDN 域名对象列表
   * @param {Object} certificate - 托管证书信息
   */
  async updateDomainCerts(domains, certificate) {
    const currentDate = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    // 遍历更新 CDN 域名的证书配置
    for (const item of domains) {
      const domain = item.Domain;
      if (this.isDomainMatch(domain, certificate.SubjectAltName)) {
        try {
          await this.cdnClient.request("UpdateDomainConfig", {
            Domain: domain,
            Https: {
              Switch: "on",
              Http2: "on",
              OcspStapling: "on",
              Hsts: { Switch: "on", MaxAge: 31536000 },
              CertInfo: { CertId: certificate.CertificateId, Message: `更新日期: ${currentDate}` }
            }
          });
          console.log(`域名 [${domain}] 证书更新成功`);
        } catch (err) {
          console.error(`域名 [${domain}] 证书更新失败:\n ${err}`);
        }
      }
    }
  }

  /**
   * 检查域名是否与证书的任意绑定域名匹配。
   * 
   * @param {string} domain - 要检查的域名
   * @param {string[]} certDomains - 证书 SAN 域名
   * @returns {boolean} - 如果匹配则返回 true，否则 false
   */
  isDomainMatch(domain, certDomains) {
    if (!certDomains || !Array.isArray(certDomains)) return false;

    for (const certDomain of certDomains) {
      if (certDomain.startsWith("*.")) {
        const baseDomain = certDomain.slice(2);
        if (domain === baseDomain) return true;
        if (domain.endsWith("." + baseDomain)) {
          const prefix = domain.slice(0, domain.length - baseDomain.length - 1);
          if (prefix && !prefix.includes(".")) return true;
        }
      } else if (domain === certDomain) {
        return true;
      }
    }
    return false;
  }

  /**
   * 删除与当前证书域名匹配的旧证书。
   * 
   * @param {Object} certInfo - 证书信息
   * @param {string} certificate - 托管证书信息
   */
  async deleteOldCertificates(certInfo, certificate) {
    if (this.sslCerts && Array.isArray(this.sslCerts.Certificates)) {
      // 寻找出待删除的证书列表
      // 1.证书 ID 与新证书 ID 不相等
      // 2.证书失效时间小于等于待上传证书失效时间
      // 3.证书 Domain 和 SubjectAltName 与新证书完全匹配一致
      const certDeleteQueue = this.sslCerts.Certificates.filter(item =>
        item.CertificateId !== certificate.CertificateId
        && new Date(item.CertEndTime) <= new Date(certificate.CertEndTime)
        && JSON.stringify(item.SubjectAltName) === JSON.stringify(certInfo.subjectAltName)
        && item.Domain === certInfo.domain
      );

      if (certDeleteQueue.length === 0) {
        console.log(`当前证书有效至 ${certificate.CertEndTime}，未发现需要删除的旧证书。`);
      } else {
        // 原则上应该先查询下是否有关联的云资源，不过如果存在的话会删除失败，就不查了
        // → FailedOperation.DeleteResourceFailed	证书已关联云资源，无法删除。
        for (const cert of certDeleteQueue) {
          try {
            await this.sslClient.request("DeleteCertificate", { CertificateId: cert.CertificateId });
            console.log(`删除证书: ${cert.CertificateId}，主题: ${cert.Domain}`);
          } catch (err) {
            console.error(`删除证书 ${cert.CertificateId} 失败:\n ${err}`);
          }
        }
      }
    }
  }
}

/**
 * 验证环境变量：先尝试环境变量，若失败则从 .env 文件读取
 * 
 * @returns {Object} - 包含 secretId 和 secretKey 的配置对象
 */
function validateEnv() {
  const requiredEnvVars = ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'];
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
  }

  const envConfig = {
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY
  };
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`缺少必要配置: ${missingVars.join(', ')}，请检查环境变量或 ${envPath}`);
  }

  return envConfig;
}

/**
 * 主函数：运行证书更新器
 */
async function main() {
  // 校验环境变量
  const config = validateEnv();

  // 证书所在路径：工作目录或指定路径下
  const certPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : process.cwd();

  // 腾讯云证书的更新、上传和删除
  const updater = new CertUpdater(config);
  await updater.update(certPath);
}

// 异步调用主函数并处理潜在的异常
main().catch((err) => {
  console.error(`脚本执行失败:\n${err}`);
  process.exit(1);
});
