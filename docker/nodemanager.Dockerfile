# YARN NodeManager with Python 3.8, needed because Hadoop Streaming runs
# "python3 mapper.py" on this node. The base image is CentOS 7 (EOL, only Python 2),
# so packages come from the CentOS vault, and Python 3.8 from Software Collections
# (mapper/reducer use sys.stdout.reconfigure, which needs Python 3.7+).
FROM apache/hadoop:3.3.6

USER root
RUN rm -f /etc/yum.repos.d/*.repo \
 && printf '%s\n' \
      '[base]' 'name=base' 'baseurl=http://vault.centos.org/7.9.2009/os/x86_64/' 'gpgcheck=0' \
      '[updates]' 'name=updates' 'baseurl=http://vault.centos.org/7.9.2009/updates/x86_64/' 'gpgcheck=0' \
      '[sclo-rh]' 'name=sclo-rh' 'baseurl=http://vault.centos.org/7.9.2009/sclo/x86_64/rh/' 'gpgcheck=0' \
      > /etc/yum.repos.d/vault.repo \
 && yum -y -q install rh-python38 \
 && yum clean all && rm -rf /var/cache/yum \
 && printf '%s\n' '#!/bin/sh' \
      'export LD_LIBRARY_PATH=/opt/rh/rh-python38/root/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' \
      'exec /opt/rh/rh-python38/root/usr/bin/python3 "$@"' > /usr/bin/python3 \
 && chmod +x /usr/bin/python3 \
 && python3 --version
USER hadoop
