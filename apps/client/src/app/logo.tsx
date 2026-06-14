import { useNavigate } from 'react-router-dom';
import { BidWiseLogo } from '@bid-wise/common-components';

export function AppLogo() {
  const navigate = useNavigate();
  return <BidWiseLogo onClick={() => navigate('/projects')} />;
}
